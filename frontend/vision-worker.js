/* Inference runs off the UI thread. Only local ImageBitmaps cross this boundary. */
self.exports={};
importScripts('./vendor/vision_bundle.js','./sensing.js');
let pose=null,face=null,analyzer=new ErgoAnalyzer();
self.onmessage=async({data})=>{
 try{
  if(data.type==='init'){
   const {FilesetResolver,PoseLandmarker,FaceLandmarker}=self.exports;
   const files=await FilesetResolver.forVisionTasks(new URL('./vendor/wasm',self.location.href).href);
   pose=await PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:new URL('./models/pose.task',self.location.href).href,delegate:'CPU'},runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.6,minPosePresenceConfidence:.6,minTrackingConfidence:.6});
   face=await FaceLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:new URL('./models/face.task',self.location.href).href,delegate:'CPU'},runningMode:'VIDEO',numFaces:1,outputFaceBlendshapes:true});
   self.postMessage({type:'ready'});
  }else if(data.type==='calibrate'){analyzer.calibrate(data.now);}
  else if(data.type==='exercise'){analyzer.startExercise(data.exercise,data.now);}
  else if(data.type==='cancel'){analyzer.cancelExercise();}
  else if(data.type==='frame'&&pose&&face){
   try{const p=pose.detectForVideo(data.bitmap,data.now),f=face.detectForVideo(data.bitmap,data.now);const result=analyzer.process(p.landmarks[0],f.faceLandmarks[0],f.faceBlendshapes[0]?.categories,data.now);self.postMessage({type:'result',result});}finally{data.bitmap.close();}
  }
 }catch(error){if(data.bitmap)try{data.bitmap.close();}catch{}self.postMessage({type:'error',message:String(error.message||error)});}
};
