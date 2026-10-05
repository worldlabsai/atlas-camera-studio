import { FloatType, RedFormat, Vector3 } from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import type { Camera } from "./types";
import { cameraPose } from "./camera";

export type PointCloudData = { positions: Float32Array; colors: Float32Array; medianDepth: number; focus: [number, number, number] };
export async function decodePointCloud(imageResponse: Response, depthResponse: Response, camera: Camera, signal: AbortSignal, maxPoints = 20000): Promise<PointCloudData> {
  const [imageBlob, depthBuffer] = await Promise.all([imageResponse.blob(), depthResponse.arrayBuffer()]);
  if(signal.aborted) throw new DOMException("Aborted","AbortError");
  const bitmap = await createImageBitmap(imageBlob);
  try {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", {willReadFrequently:true}); if(!context) throw new Error("Could not read the source image.");
    context.drawImage(bitmap,0,0); const rgba=context.getImageData(0,0,bitmap.width,bitmap.height).data;
    const decoded = new EXRLoader().setDataType(FloatType).setOutputFormat(RedFormat).parse(depthBuffer) as {width:number;height:number;data:Float32Array};
    const width=decoded.width,height=decoded.height,depths=decoded.data;
    const depthAt=(x:number,y:number)=>depths[(height-1-y)*width+x];
    const stride=Math.max(1,Math.ceil(Math.sqrt(width*height/maxPoints)));
    const sampled:number[]=[];
    for(let y=0;y<height;y+=stride)for(let x=0;x<width;x+=stride){const d=depthAt(x,y);if(Number.isFinite(d)&&d>0)sampled.push(d);}
    if(!sampled.length)throw new Error("The depth map has no usable positive depth values.");
    sampled.sort((a,b)=>a-b);const medianDepth=sampled[Math.floor(sampled.length/2)];
    const {intrinsics}=camera,pose=cameraPose(camera),positions:number[]=[],colors:number[]=[];
    const sx=width/bitmap.width,sy=height/bitmap.height;
    for(let y=0;y<height;y+=stride)for(let x=0;x<width;x+=stride){
      const d=depthAt(x,y);if(!Number.isFinite(d)||d<=0)continue;
      const u=(x+.5)/sx,v=(y+.5)/sy;
      const local=[(u-intrinsics.cx)/intrinsics.fx*d,-(v-intrinsics.cy)/intrinsics.fy*d,-d] as const;
      // Apply the RUB camera rotation to each reconstructed camera-space point.
      const point=pose.position.clone().add(new Vector3(local[0],local[1],local[2]).applyQuaternion(pose.quaternion));
      positions.push(point.x,point.y,point.z);
      const ix=Math.min(bitmap.width-1,Math.floor(u)),iy=Math.min(bitmap.height-1,Math.floor(v)),ci=(iy*bitmap.width+ix)*4;
      colors.push(rgba[ci]/255,rgba[ci+1]/255,rgba[ci+2]/255);
    }
    if(signal.aborted)throw new DOMException("Aborted","AbortError");
    const forward=new Vector3(0,0,-1).applyQuaternion(pose.quaternion);
    const focus=pose.position.clone().addScaledVector(forward,medianDepth);
    return {positions:new Float32Array(positions),colors:new Float32Array(colors),medianDepth,focus:[focus.x,focus.y,focus.z]};
  } finally { bitmap.close(); }
}
