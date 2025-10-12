const assets=require('./server/utils/wakeWordAssets');
const res=assets.getAssetsForWakeWords(['Anna'],{allowGeneric:true});
console.log(JSON.stringify(res,null,2));
