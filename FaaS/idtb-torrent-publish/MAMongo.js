const Mam = require('@iota/mam');
const crypto = require('crypto');
const assert = require('assert');
const uuid4 = require('uuid/v4');
const { MongoClient } = require('mongodb');
const { asciiToTrytes, trytesToAscii } = require('@iota/converter');
const { createHttpClient } = require('@iota/http-client');
const { composeAPI } = require('@iota/core');
const { createContext, Reader, Mode , getIDForMode } = require('@iota/mam/lib/mam.js')

const keyGen = length =>  {
	const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ9'
	let key = ''
	while (key.length < length) {
		let byte = crypto.randomBytes(1)
		if (byte[0] < 243) {
			key += charset.charAt(byte[0] % 27)
		}
	}
	return key
}


class MongoMAM {
	constructor( IotaSetings ,  dbURI  ){
		this.provider = undefined ;
		this.attachToTangle = undefined ;
		this.client = undefined ;
		this.db = undefined ;
		this.dbURI = dbURI ;
		this.id = undefined ; 
		this.IDs = {} ; 
		this.root = undefined ; 
		
		if (typeof IotaSetings === 'object') {
			this.provider = IotaSetings.provider
			if (IotaSetings.attachToTangle) {
				this.attachToTangle = IotaSetings.attachToTangle
			}
		} else {
			this.provider = IotaSetings
		}
	}
	
	async connect() {
		const dbURI = this.dbURI		
		this.client = await MongoClient.connect(dbURI , { useNewUrlParser: true,useUnifiedTopology: true } )
		this.db = await this.client.db('BTiota')

		// console.log('[MongoDB]:' ,  '<func:connect>'  , this.dbURI );
	}

	async close(){
		// console.log("Closing db");
		// console.log('[MongoDB]:' ,  '<func:connect>' ,this.client);
				
		if( this.client !== undefined){
			try{
				if(this.client.isConnected()){
					
					await this.client.close() ;
					
				}else{
					
				}
				
			}catch(err){				
				throw(err);
			}			
		}
		
		
	}
	
	static  async init ( IotaSetings ,  dbURI ) {
		const obj = new MongoMAM( IotaSetings , dbURI ) ;
		// await obj.connect() ;
		
		// console.log( 'db' , obj.db , "\n")
		
		return  obj ;
	}
	

	async checkID(id){
		const query = {
			_id: id 
		}
		const option ={
			limit:1
		}
		try{
			const collection = await this.db.collection('mam')
			const result = await collection.countDocuments(query ,option )
			if ( result == 1 ) {
				return id ;
			} else {
				return void 0 ;
			}			
		}catch(err){
			this.close()
			throw(err)
		}
	}

	
	async channel( id=undefined ) {
		if( id == undefined ){
			// console.log('[MongoDB]:' ,  '<func:channel>'  , 'ID undefined , Call <func:create> ' )
			this.id = await this.createChannel() ;

		}else if(  await this.checkID(id)  ){
			// console.log('[MongoDB]:' ,  '<func:channel>'  , 'ID exist'  , id  )
			this.id = id ;

		}else{
			// console.log('[MongoDB]:' ,  '<func:channel>'  , 'ID not exist'  , id  )
			this.id = await this.createChannel( id=id ) ;
		}
		return this.id
	}

	async publicMessage( obj={} , tag=''  , depth=3 , mwm=9 ){
		try{
			const id = this.id ;
			if( id == undefined ){
				throw("MongoMAM ID Not Found")
			}
			const trytes = asciiToTrytes(JSON.stringify(obj)) ;
			const message = await this.createMessage(trytes) ;
			// console.log(message.state)
			await this.attach(message.payload, message.address, depth , mwm, tag ) ;
			// const mode = message.state.channel.mode ;
			const fetch_result = await this.fetchSingle( message.root , 'private') ; 
			// console.log(fetch_result)
			if( fetch_result.payload == undefined  ){
				throw("Attach To Tangle Failed , Can't Fetch Message!")
			}
			// console.log('[MongoDB]:' ,  '<func:publicMessage>'  , 'fetch result\n' ,  fetch_result , '\n' ) ;
			//const fetch_payload = fetch_result.payload ;
			//const fetch_data = trytesToAscii() ;
			const res = await this.updateChannelState(message.state , message.root )  ;
			let info = {};
			info.address = message.address ;
			info.root = this.root ; 
			info.present = message.root ;
			info.message = fetch_result ;
			return info ;
		}catch(err){
			this.close() ;
			throw(err)
		}

	}

	async updateChannelState( state , root ){
		try{
			// console.log('[MongoDB]:' ,  '<func:updateChannelState>'  , 'Channel\n' ,  state , '\n' ) ;
			// console.log('[MongoDB]:' ,  '<func:updateChannelState>'  , 'address\n' ,  address , '\n' ) ;

			const id = this.id ;
			if( id == undefined ){
				throw("MongoMAM ID Not Found")
			}
			const query = {
				_id : id 
			} ;
			const collection = await this.db.collection('mam');
			const result = await collection.findOneAndUpdate({ _id:id } , { $set: { channel:state.channel , present:root } } );
			//console.log(result) ; 
			if( result.value.root  == null ){
				await collection.updateOne( { _id:id } , { $set:{ root:root  } }  );
				this.root = root ;
			}else{
				this.root = result.value.root ;
			}

			//

		}catch(err){
			this.close()
			throw(err)
		}

	}

	async createMessage( trytes ){
		try{
			const id = this.id ;
			if( id == undefined ){
				throw("MongoMAM ID Not Found")
			}
			const collection = await this.db.collection('mam');
			const result = await collection.findOne({ _id : id });
			if(result == null) {
				throw("MongoMAM Can't Get Channel Status")
			}
			// console.log('[MongoDB]:' ,  '<func:createMessage>'  , 'Get MAM State From MongoDB\n' ,  result , '\n' ) ;
			

			const state = {
				channel:result.channel ,
				seed:result.seed
			};
			const message = Mam.create(state, trytes);
			// console.log('[MongoDB]:' ,  '<func:createMessage>'  , 'Candidate Message MAM State\n' ,  message.state , '\n' ) ;
			return message ;
		}catch(err){
			this.close()
			throw(err)
		}

	}
	
	
	async createChannel( id = uuid4()  ,  seed=keyGen(81) , security=2 ) { 
		if(  await this.checkID(id)  ){
			// console.log('[MongoDB]:' ,  '<func:createChannel>'  , 'ID exist'  , id  )
			return id;
		}
		const channel = {
			side_key: null,
			mode: 'private',
			next_root: null,
			security,
			start: 0,
			count: 1,
			next_count: 1,
			index: 0
		} ;
		const meta = {
			_id : id ,
			channel ,
			root:null,
			seed 
		} ;

		try{
			const collection = await this.db.collection('mam')
			const result = await collection.insertOne(meta)
			assert.equal(1, result.result.n);
			assert.equal(1, result.ops.length);
		}catch(err){
			this.close()
			throw(err)
		}
		
    	//
    	//

		//client.close() ; 
		//console.log('[MongoDB]:' ,  '<func:create>' ,'Create Channel' ,  id , '\n'  , meta , '\n' )
		return id ;
	}
	
	async attach(trytes, root, depth = 3, mwm = 9, tag = '') {
		const transfers = [	
		{address: root,
			value: 0,
			message: trytes,
			tag: tag
		}
		]
		try {

			const { prepareTransfers, sendTrytes } = composeAPI({ provider:this.provider, attachToTangle:this.attachToTangle });
			const trytes = await prepareTransfers('9'.repeat(81), transfers, {})
			return sendTrytes(trytes, depth, mwm)
		} catch (e) {
			this.close()
			throw `failed to attach message: ${e}`
		}
	}
	
	
	async fetch (root, selectedMode, sidekey, callback, limit)  {
		try {
			let client = createHttpClient({ provider:this.provider, attachToTangle:this.attachToTangle })
			let ctx = await createContext()
			const messages = []
			const mode = selectedMode === 'public' ? Mode.Public : Mode.Old
			let hasMessage = false
			let nextRoot = root
			let localLimit = limit || Math.pow(2, 53) - 1


			do {
				let reader = new Reader(ctx, client, mode, nextRoot, sidekey || '')
				const message = await reader.next()
				hasMessage = message && message.value && message.value[0]
				//console.log(hasMessage)
				if (hasMessage) {
					nextRoot = message.value[0].message.nextRoot
					const payload = message.value[0].message.payload

               		// Push payload into the messages array
               		messages.push(payload)

                	// Call callback function if provided
                	if (callback) {
                		callback(payload)
                	}
                }
            } while (!!hasMessage && messages.length < localLimit)
            return { messages, nextRoot }
        } catch (e) {
        	this.close()
        	throw e
        }
    }

    async fetchSingle(root, selectedMode, sidekey)  {
    	try{
    		const response = await this.fetch(root, selectedMode, sidekey, undefined, 1)
    		//console.log('[MongoDB]:' ,  '<func:fetchSingle>'  , 'fetch result\n' ,  response , '\n' ) ;
    		return response && response.nextRoot ? {
    			payload: response.messages && response.messages.length === 1 ? response.messages[0] : undefined,
    			nextRoot: response.nextRoot
    		} : response
    	} catch (e) {
    		this.close()
    		throw e
    	}
    }

}

module.exports = MongoMAM