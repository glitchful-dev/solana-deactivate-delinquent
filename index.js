const web3 = require('@solana/web3.js')
// const fetch = require('node-fetch')
const fs = require('fs')

const U64_MAX = '18446744073709551615'
const MAX_IX_PER_TX = 23
const MINIMUM_DELINQUENT_EPOCHS_FOR_DEACTIVATION = 5

const sleep = async (ms) => new Promise((r) => setTimeout(r, ms))
const logger = async (...log) => console.log(new Date().toISOString(), ...log)
const getEnvVar = (key) => {
    const envVarValue = process.env[key]
    if (!envVarValue) {
        throw new Error(`Environment variable ${key} is not defined!`)
    }
    return envVarValue
}

const keypair = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(getEnvVar('KEYPAIR'), 'utf8'))))
const connection = new web3.Connection('https://api.mainnet-beta.solana.com')

const chunkArray = (arr, size) => {
    const chunkedArray = []
    for (let i = 0; i < arr.length; i += size) {
        chunkedArray.push(arr.slice(i, i + size))
    }
    return chunkedArray;
}

const fetchData = async () => {
    const result = await fetch("http://validators-api.marinade.finance/validators?limit=9999&epochs=10", {
        headers: { 'Content-Encoding': 'gzip' }
    })
    return await result.json()
}

const getEpochRange = (validators, epochs) => {
    let maxEpoch = 0
    for (const validator of validators) {
        for (const { epoch } of validator.epoch_stats) {
            maxEpoch = Math.max(epoch, maxEpoch)
        }
    }
    return [maxEpoch - epochs + 1, maxEpoch]
}

const findDelinquentValidators = (validators, from, to) => {
    const delinquent = []

    for (const validator of validators) {
        const delinquenciesInTheRange = validator
            .epoch_stats
            .filter(({ epoch }) => from <= epoch && epoch <= to)
            .filter(({ credits }) => credits === 0)
            .length

        if (delinquenciesInTheRange === to - from + 1) {
            delinquent.push(validator.vote_account)
        }
    }

    return delinquent
}

const findReferenceValidator = (validators, from, to) => {
    for (const validator of validators) {
        const delinquenciesInTheRange = validator
            .epoch_stats
            .filter(({ epoch }) => from <= epoch && epoch <= to)
            .filter(({ credits }) => credits === 0)
            .length

        if (delinquenciesInTheRange === 0) {
            return validator.vote_account
        }
    }
    throw new Error('No reference validator found!')
}
const getAccountsToDeactivate = async (epoch, validator) => {
    const log = (...args) => logger('STAKES', ...args)

    const stakeAccounts = await connection.getParsedProgramAccounts(web3.StakeProgram.programId, {
        filters: [{
            memcmp: {
                bytes: validator,
                offset: 4 + (8 + 32 + 32) + (8 + 8 + 32)
            }
        }]
    })
    log('Found: ', stakeAccounts.length, ' accounts for delinquent validator', validator)

    const deactivable = stakeAccounts.filter(({ account, pubkey }) => {
        const delegation = account.data.parsed?.info?.stake?.delegation
        if (!delegation) {
            throw new Error(`Delegation for stake account ${pubkey} not found!`)
        }

        const activating = delegation.activationEpoch === epoch.toString() && U64_MAX === delegation.deactivationEpoch
        if (activating) {
            log(`Stake account ${pubkey} is activating: `, account.lamports / 1e9)
            return true
        }
        const deactivating = delegation.deactivationEpoch === epoch.toString() && delegation.activationEpoch !== delegation.deactivationEpoch
        if (deactivating) {
            log(`Stake account ${pubkey} is de-activating: `, account.lamports / 1e9)
            return false
        }
        const deactivated = !deactivating && U64_MAX !== delegation.deactivationEpoch
        if (deactivated) {
            log(`Stake account ${pubkey} is de-activated: `, account.lamports / 1e9)
            return false
        }

        log(`Stake account ${pubkey} is activate: `, account.lamports / 1e9)
        return true
    })
    log('Found: ', deactivable.length, ' accounts that can be de-activated delinquent validator', validator)

    return deactivable
}

const deactivateDelinquentAccounts = async (accounts, delinquentValidator, referenceValidator) => {
    const log = (...args) => logger('DEACTIVATE', ...args)

    const { blockhash } = await connection.getLatestBlockhash()
    log('Blockhash:', blockhash)

    const confirmationPromises = []

    for (const chunk of chunkArray(accounts, MAX_IX_PER_TX)) {

        const instructions = []
        for (const account of chunk) {
            instructions.push(new web3.TransactionInstruction({
                keys: [
                    { pubkey: new web3.PublicKey(account.pubkey), isSigner: false, isWritable: true },
                    { pubkey: new web3.PublicKey(delinquentValidator), isSigner: false, isWritable: false },
                    { pubkey: new web3.PublicKey(referenceValidator), isSigner: false, isWritable: false },
                ],
                programId: web3.StakeProgram.programId,
                data: Buffer.from([0x0e, 0x00, 0x00, 0x00])
            }))
        }
        const messageV0 = new web3.TransactionMessage({
            payerKey: keypair.publicKey,
            recentBlockhash: blockhash,
            instructions,
        }).compileToV0Message()

        const tx = new web3.VersionedTransaction(messageV0)
        tx.sign([keypair])

        const signature = await connection.sendTransaction(tx)
        log('Sent tx:', signature, `https://explorer.solana.com/tx/${signature}`)
        confirmationPromises.push(connection.confirmTransaction(signature))

        await sleep(100)
    }

    log('Waiting for confirmations...')
    await Promise.all(confirmationPromises)
    log('Confirmed.')
}

const unstakeDelinquents = async () => {
    const log = (...args) => logger('FIND', ...args)
    let totalDeactivated = 0

    try {
        const validatorsApiResponse = await fetchData()
        const [from, to] = getEpochRange(validatorsApiResponse.validators, MINIMUM_DELINQUENT_EPOCHS_FOR_DEACTIVATION)
        log('Found epoch range to explore: ', from, to)

        const delinquentValidators = findDelinquentValidators(validatorsApiResponse.validators, from, to)
        if (delinquentValidators.length === 0) {
            log('No validators match the delinquency criteria')
            return
        }

        log('Found delinquent validators', delinquentValidators)

        const referenceValidator = findReferenceValidator(validatorsApiResponse.validators, from, to)
        log('Found reference validator', referenceValidator)

        for (const delinquentValidator of delinquentValidators) {
            try {
                const accounts = await getAccountsToDeactivate(to, delinquentValidator)

                if (accounts.length > 0) {
                    await deactivateDelinquentAccounts(accounts, delinquentValidator, referenceValidator)
                    totalDeactivated += accounts.reduce((total, { account }) => total + account.lamports, 0)
                    log('Deactivated stake accounts with total balance:', )
                } else {
                    log('No deactivations possible for this validator')
                }
            } catch (err) {
                log('Error processing validator', delinquentValidator, err.message, err)
            }
        }
    } catch (err) {
        log('Error processing the workflow', err.message, err)
    }

    log('Total de-activated:', totalDeactivated / 1e9)
}

unstakeDelinquents()
