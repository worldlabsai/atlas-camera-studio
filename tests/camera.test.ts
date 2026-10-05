import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import { cameraPose, interpolateCameras, toCamera } from "../src/camera";
test("RDF camera orientation is converted into Three RUB coordinates",()=>{const camera=toCamera({position:new Vector3(0,0,0),quaternion:new Quaternion()});camera.extrinsics.coordinateSystem="rdf";const pose=cameraPose(camera);const forward=new Vector3(0,0,-1).applyQuaternion(pose.quaternion);assert.ok(forward.z>0.99);});
test("interpolation returns exactly the requested count and preserves endpoints",()=>{const a={position:new Vector3(0,0,0),quaternion:new Quaternion()},b={position:new Vector3(10,2,0),quaternion:new Quaternion().setFromAxisAngle(new Vector3(0,1,0),1)};const result=interpolateCameras([a,b],48);assert.equal(result.length,48);assert.deepEqual(result[0].extrinsics.position,[0,0,0]);assert.ok(Math.abs(result[47].extrinsics.position[0]-10)<1e-8);});
test("invalid values and zero quaternions never leave invalid camera values",()=>{const cam=toCamera({position:new Vector3(NaN,Infinity,-1),quaternion:new Quaternion(0,0,0,0)});assert.ok([...cam.extrinsics.position,...cam.extrinsics.quaternion].every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...cam.extrinsics.quaternion)-1)<1e-8);});
