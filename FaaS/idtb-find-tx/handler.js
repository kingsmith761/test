"use strict"
//idtb-find-tx
const { MongoClient } = require('mongodb');
const { generateAddress, composeAPI } = require('@iota/core');
const { trytesToAscii } = require('@iota/converter');
const Extract = require('@iota/extract-json');
const Mam = require('@iota/mam');

let iota = undefined;

const isArray = (a) => {
    return (!!a) && (a.constructor === Array);
};
const isObject = (a) => {
    return (!!a) && (a.constructor === Object);
};

let dbClient = undefined;
let db = undefined;
const close_db = async () => {
    //console.log("closeDB")
    if (dbClient !== undefined) {
        if (dbClient.isConnected()) {
            await dbClient.close();
        }
    }
}

const fetchTorrent = async (torrent_root) => {
    let mam_resault = await Mam.fetchSingle(torrent_root, 'private');
    if (mam_resault.payload == undefined) {
        return undefined;
    }
    return JSON.parse(trytesToAscii(mam_resault.payload));
}

const findAddressTX = async (address) => {
    let transaction = [];
    await iota.findTransactions({ addresses: [address] })
        .then(async (trytes) => {
            let list = [];
            await iota.getTransactionObjects(trytes)
                .then(async (array) => {
                    for (let i = 0; i < array.length; i++) {
                        let decodeTX1 = Date.now();
                        await iota.getBundle(array[i].hash)
                            .then(bundle => {
                                // Get your hello world message from the transaction's `signatureMessageFragment` field and print it to the console
                                transaction.push(JSON.parse(Extract.extractJson(bundle)));
                            })
                    }
                })
        })
        .catch(err => {
            console.log('<findTransactions> err:', err)
        })
    return transaction;
}



const myhandler = async (config, callback) => {
    let torrentInfo = await fetchTorrent(config.root);
    const tz_options = { timeZone: 'Asia/Taipei', timeZoneName: 'short', hour12: false };
    let st = new Date()
    let date = st.toLocaleString('zh', tz_options);
    let stTime = Math.floor(st.getTime() / 1000);
    let pbTime = torrentInfo.timestamp;
    let delTime = stTime - pbTime;
    if (delTime < 0) {
        delTime = 0;
    }
    let slot = Math.floor(delTime / 600);
    console.log(stTime, slot);
    let addressRoot = config.root;
    let address = generateAddress(addressRoot, slot, 2);
    let TX = await findAddressTX(address);
    callback(undefined, JSON.stringify(TX));
}

module.exports = async (context, callback) => {
    console.log(new Date())
    let provider = undefined;
    let myATT = undefined;
    let config = {};
    config.mwm = 14;
    config.depth = 1;
    // provider
    if (process.env.provider) {
        provider = process.env.provider
    } else {
        callback("provider not defined in env", undefined);
        return;
    }
    // remotePOW
    if (process.env.remotePOW) {
        const pow_server = process.env.remotePOW
        console.log("pow_server", pow_server)
        // rewrite attachToTangle function 
        myATT = async (trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback) => {
            //console.log("Light Wallet: localAttachToTangle" , pow_server  , '\n');
            let { attachToTangle } = composeAPI({ provider: pow_server });
            let resault = await attachToTangle(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback);
            return resault;
        }
    }
    config.provider = { provider, attachToTangle: myATT };

    // mongodb
    if (process.env.mongodb) {
        config.mongodb = process.env.mongodb
    } else {
        config.mongodb = "mongodb://mongo:27017";
    }

    try {
        const input = JSON.parse(context);
        if (isObject(input) !== true) {
            callback("not a json", context);
        }
        if (!('root' in input)) {
            throw "require address";
        } else {
            config.root = input.root;
        }

        Mam.init(config.provider)
        iota = composeAPI(config.provider)


        myhandler(config, callback)
            .catch(error => {
                close_db();
                callback(error, undefined);
            });

    } catch (error) {
        callback(error, undefined);
    }

}