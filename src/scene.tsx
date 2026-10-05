import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, Line } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, Vector3 } from "three";
import type { Camera } from "./types";
import { cameraPose, interpolateCameras } from "./camera";
import type { PointCloudData } from "./pointcloud";

function Cloud({data}:{data:PointCloudData}) {
 const geometry=useMemo(()=>{const g=new BufferGeometry();g.setAttribute("position",new BufferAttribute(data.positions,3));g.setAttribute("color",new BufferAttribute(data.colors,3));return g},[data]);
 useEffect(()=>()=>geometry.dispose(),[geometry]);
 return <points geometry={geometry}><pointsMaterial vertexColors size={0.025} sizeAttenuation/></points>;
}
function CameraRig({ cameras, progress }: { cameras: Camera[]; progress: number }) {
  const poses = useMemo(() => cameras.map(cameraPose), [cameras]);
  const positions = poses.length ? poses.map(p => p.position) : [new Vector3(0, 0, 4), new Vector3(1, .4, 3)];
  const current = positions[Math.min(positions.length - 1, Math.floor(progress * (positions.length - 1)))] ?? positions[0];
  return <group>
    {positions.length > 1 && <Line points={positions} color="#b4f4d5" lineWidth={2} />}
    {positions.map((p, i) => <group key={i} position={p.toArray()} quaternion={poses[i]?.quaternion}><mesh><coneGeometry args={[.11, .35, 4]} /><meshBasicMaterial color={i === 0 ? "#b4f4d5" : "#709b88"} /></mesh><mesh position={[0, 0, -.18]}><boxGeometry args={[.18, .12, .025]} /><meshBasicMaterial color="#d4ffeb" /></mesh></group>)}
    <mesh position={current.toArray()}><sphereGeometry args={[.08, 16, 16]} /><meshBasicMaterial color="#fff" /></mesh>
  </group>;
}
function PreviewCamera({pose}:{pose:ReturnType<typeof cameraPose>}) {
 const camera=useThree(s=>s.camera);
 useEffect(()=>{camera.position.copy(pose.position);camera.quaternion.copy(pose.quaternion);camera.updateProjectionMatrix()},[camera,pose]);
 return null;
}
export function Scene({ cameras, progress, pointCloud }: { cameras: Camera[]; playing: boolean; progress: number; pointCloud?: PointCloudData|null }) {
 const poses=useMemo(()=>interpolateCameras(cameras.map(cameraPose),Math.max(2,cameras.length*12),cameras[0]?.intrinsics).map(cameraPose),[cameras]);
 const previewPose=poses[Math.min(poses.length-1,Math.floor(progress*(poses.length-1)))]||cameraPose(cameras[0]);
 const focus: [number,number,number]=pointCloud?pointCloud.focus:[0,0,0];const distance=pointCloud?pointCloud.medianDepth:1;const orbitPosition: [number,number,number]=pointCloud?[focus[0]+distance*.8,focus[1]+distance*.45,focus[2]+distance*1.35]:[4,3,6];
 const previewFov=cameras[0]?2*Math.atan(cameras[0].intrinsics.height/(2*cameras[0].intrinsics.fy))*180/Math.PI:45;
 return <>
  <Canvas camera={{ position: orbitPosition, fov: 45 }} gl={{ antialias: true }}><color attach="background" args={[new Color("#101615")]} /><ambientLight intensity={1.2}/><Grid args={[12,12]} cellColor="#25302d" sectionColor="#35423c" fadeDistance={14} position={[0,-.08,0]} />{pointCloud?<Cloud data={pointCloud}/>:<group><mesh position={[0,1,0]}><boxGeometry args={[3,2,.08]}/><meshStandardMaterial color="#26302f" wireframe/></mesh><mesh position={[0,0,-1.5]}><boxGeometry args={[3,.08,3]}/><meshStandardMaterial color="#1c2424" wireframe/></mesh></group>}<CameraRig cameras={cameras} progress={progress}/><OrbitControls makeDefault enableDamping target={focus} /></Canvas>
  {pointCloud&&<div className="camera-preview"><div className="preview-label">CAMERA PREVIEW</div><Canvas camera={{position:previewPose.position.toArray(),fov:previewFov,near:.01,far:1000}} gl={{antialias:true,alpha:false}}><color attach="background" args={["#111714"]}/><PreviewCamera pose={previewPose}/><Cloud data={pointCloud}/></Canvas></div>}
 </>;
}
