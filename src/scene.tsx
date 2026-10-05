import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, OrbitControls, Line } from "@react-three/drei";
import { useMemo, useRef } from "react";
import { Color, Group, Mesh, Vector3 } from "three";
import type { Camera } from "./types";
import { cameraPose } from "./camera";
function CameraRig({ cameras, playing, progress }: { cameras: Camera[]; playing: boolean; progress: number }) {
  const group = useRef<Group>(null); const poses = useMemo(() => cameras.map(cameraPose), [cameras]);
  useFrame((_, delta) => { if (playing && group.current) group.current.rotation.y += delta * .08; });
  const positions = poses.length ? poses.map(p => p.position) : [new Vector3(0, 0, 4), new Vector3(1, .4, 3)];
  const current = positions[Math.min(positions.length - 1, Math.floor(progress * (positions.length - 1)))] ?? positions[0];
  return <group ref={group}>
    <mesh position={[0, 1, 0]}><boxGeometry args={[3, 2, .08]} /><meshStandardMaterial color="#26302f" wireframe /></mesh>
    <mesh position={[0, 0, -1.5]}><boxGeometry args={[3, .08, 3]} /><meshStandardMaterial color="#1c2424" wireframe /></mesh>
    <mesh position={[-1.45, 1, -1.5]}><boxGeometry args={[.08, 2, 3]} /><meshStandardMaterial color="#1c2424" wireframe /></mesh>
    {positions.length > 1 && <Line points={positions} color="#b4f4d5" lineWidth={2} />}
    {positions.map((p, i) => <group key={i} position={p.toArray()} quaternion={poses[i]?.quaternion}><mesh><coneGeometry args={[.11, .35, 4]} /><meshBasicMaterial color={i === 0 ? "#b4f4d5" : "#709b88"} /></mesh><mesh position={[0, 0, -.18]}><boxGeometry args={[.18, .12, .025]} /><meshBasicMaterial color="#d4ffeb" /></mesh></group>)}
    <mesh position={current.toArray()}><sphereGeometry args={[.08, 16, 16]} /><meshBasicMaterial color="#fff" /></mesh>
  </group>;
}
export function Scene({ cameras, playing, progress }: { cameras: Camera[]; playing: boolean; progress: number }) {
 return <Canvas camera={{ position: [4, 3, 6], fov: 45 }} gl={{ antialias: true }}><color attach="background" args={[new Color("#101615")]} /><ambientLight intensity={1.2}/><directionalLight position={[3,5,4]} intensity={2}/><Grid args={[12,12]} cellColor="#25302d" sectionColor="#35423c" fadeDistance={14} position={[0,-.08,0]} /><CameraRig cameras={cameras} playing={playing} progress={progress}/><OrbitControls makeDefault enableDamping /></Canvas>;
}
