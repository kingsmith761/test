"use strict"
//idtb-torrent-publish
process.on('uncaughtException', function (exception) {
	console.log('[torrent-publish]:' ,  '<func:process uncaughtException>' ,exception);
});

const  MongoMAM  = require('./MAMongo.js')
const isArray = (a) => {
	return (!!a) && (a.constructor === Array);
};

const isObject = (a) => {
	return (!!a) && (a.constructor === Object);
};

const { composeAPI } = require('@iota/core');

const myhandler = async (provider ,mongodb , channel , message , tag , depth , mwm , callback ) =>{
	const dateTime = Date.now();
	const timestamp = Math.floor(dateTime / 1000);
	const info = {} ;
	info.version = 'v0.01' ;
	info.status = 'done' ;
	//------------------------------------------
	try {
		let mam = await MongoMAM.init( provider , mongodb ) ; 
		await mam.connect()
		const id = await mam.channel(channel) ;
		let start = Date.now();
		console.log('publicMessage')
		const response = await mam.publicMessage( message , tag , depth , mwm ) ; 
		let end = Date.now();
		await mam.close();
		info.provider = provider ;
		info.mongodb = mongodb ;
		info.channel = channel ;
		info.mwm = mwm ;
		info.depth = depth ;
		info.message = message ;
		info.tag = tag ; 
		info.meta = response ;
		info.timestamp = timestamp;
		info.timecost = end-start;
		callback( undefined , info );
	}catch(error) {
		callback( error , undefined );
	}
}


const localAttachToTangle = async (trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback) => {
	//console.log("Light Wallet: localAttachToTangle" , pow_server  , '\n');
	let {attachToTangle} = composeAPI({ provider: 'http://192.168.1.100:24265' }) ;
	let resault = await attachToTangle(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback);
	return resault;
}


module.exports = (context, callback) => {
	
	//info.context = context;
	//info.type = typeof(context);
	let provider = undefined ;
	let myATT  = undefined; 
	let mongodb = undefined ;
	let channel = undefined ;
	let tag = '' ; 
	let mwm = 9 ;
	let depth = 3 ;
	let message = null ;

	// provider
	if( process.env.provider ){
		provider = process.env.provider 
	}else{
		callback( "provider not defined in env" , undefined );
		return; 
	}
	// remotePOW
	if( process.env.remotePOW ){
		const pow_server = process.env.remotePOW
		// rewrite attachToTangle function 
		myATT = async (trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback) => {
			//console.log("Light Wallet: localAttachToTangle" , pow_server  , '\n');
			let {attachToTangle} = composeAPI({ provider: pow_server }) ;
			let resault = await attachToTangle(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback);
			return resault;
		}
	}
	// mongodb
	if( process.env.mongodb ){
		mongodb = process.env.mongodb 
	}else{
		mongodb = "mongodb://mongo:27017" ;
	}

	try{
		const input = JSON.parse(context);   
		if( isObject(input) !== true   ){
			callback( "not a json" , info );
		}
		if (!('channel' in input)){
			throw "require channel id";
		}
		if ( 'tag' in input ){
			tag = input.tag ;
		}
		if ( 'mwm' in input ){
			mwm = input.mwm ;
		}
		if ( 'depth' in input ){
			depth = input.depth ;
		}
		if ( 'message' in input ){
			message = input.message ;
		}
		channel = input.channel ;
		message = input.message ;
		tag = input.tag ; 
		//-------------------------------------
		myhandler( { provider , attachToTangle:myATT } ,mongodb , channel , message , tag , depth , mwm  , callback)
		.catch(err => {
			//throw(err);
			console.error('[ERROR]:\n',err , '\n')
		}) ;
		
	}catch(error){
		callback( error , undefined );
	}

}
