"use strict"
//idtb-seeder-register

const { generateAddress, composeAPI } = require('@iota/core');
const { asciiToTrytes, trytesToAscii } = require('@iota/converter');
const Mam = require('@iota/mam');


const isArray = (a) => {
    return (!!a) && (a.constructor === Array);
};
const isObject = (a) => {
    return (!!a) && (a.constructor === Object);
};

const fetchTorrent = async (torrent_root) => {
    let mam_resault = await Mam.fetchSingle(torrent_root, 'private');
    if (mam_resault.payload == undefined) {
        return undefined;
    }
    return JSON.parse(trytesToAscii(mam_resault.payload));
}


const register = async (config, torrent) => {
    const tz_options = { timeZone: 'Asia/Taipei', timeZoneName: 'short', hour12: false };
    let st = new Date()
    let date = st.toLocaleString('zh', tz_options);
    let stTime = Math.floor(st.getTime() / 1000);
    let pbTime = torrent.timestamp;
    let delTime = stTime - pbTime;
    if (delTime < 0) {
        delTime = 0;
    }
    let slot = Math.floor(delTime / 600);
    console.log(stTime, slot)
    let addressRoot = config.root;
    let address = generateAddress(addressRoot, slot, 2);
    const iota = composeAPI(config.provider)

    let obj = {};
    obj.timestamp = stTime;
    obj.trackerInfo = torrent.trackerInfo;
    obj.seederInfo = torrent.node;

    const transfers = [{
        address: address,
        value: 0,
        tag: config.tag,
        message: asciiToTrytes(JSON.stringify(obj))
    }]

    let seed = '9'.repeat(81)
    let TX = await iota.prepareTransfers(seed, transfers).then(trytes => {
        return iota.sendTrytes(trytes, 1, 14)
    })
    console.log("Register Address:", address, new Date());
    }

const myhandler = async (config, callback) => {
    let torrentInfo = await fetchTorrent(config.root);
    let torrent = {};
    torrent.timestamp = torrentInfo.timestamp;
    torrent.trackerInfo = torrentInfo.node;
    torrent.node = config.node;
    await register(config, torrent);
    console.log("register finish");
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

    try {
        const input = JSON.parse(context);
        if (isObject(input) !== true) {
            callback("not a json", context);
        }
        if (!('root' in input)) {
            throw "require root";
        } else {
            config.root = input.root;
        }
        if (!('node' in input)) {
            throw "require root";
        } else {
            config.node = input.node;
        }

        Mam.init(config.provider)
        myhandler(config, callback)
            .catch(error => {
                // close_db();
                callback(error, undefined);
            });

    } catch (error) {
        callback(error, undefined);
    }


}