'use strict';

// Cuts a sub-pack out of a built pack: the given edges, the nodes they touch, the stations accepted by
// `keepStation` (with the snaps whose edges survived) and the signals on kept edges. No overview.
// Used to make the small real-data fixtures the offline tests run on.

const { StringTable } = require('./assemble');

function cutPack(pack, edgeSet, keepStation, { signals = true } = {}) {
  const s = pack.s;
  const keepEdge = [...edgeSet].sort((a, b) => a - b);
  const nodeMap = new Map();
  const nid = (n) => { if (!nodeMap.has(n)) nodeMap.set(n, nodeMap.size); return nodeMap.get(n); };
  const strings = new StringTable();
  const edgeMap = new Map(keepEdge.map((e, i) => [e, i]));
  const nE = keepEdge.length;
  const out = {
    EFROM: new Uint32Array(nE), ETO: new Uint32Array(nE), EVO: new Uint32Array(nE + 1), ELEN: new Float32Array(nE),
    ECLS: new Uint8Array(nE), EELEC: new Uint8Array(nE), ESPD: new Uint8Array(nE), EFLG: new Uint8Array(nE),
    ENAME: new Uint32Array(nE), EREF: new Uint32Array(nE), ETRK: new Uint32Array(nE)
  };
  const vlat = [], vlon = [];
  keepEdge.forEach((e, i) => {
    out.EFROM[i] = nid(s.EFROM[e]); out.ETO[i] = nid(s.ETO[e]);
    for (let v = pack.evo[e]; v < pack.evo[e + 1]; v++) { vlat.push(s.VLAT[v]); vlon.push(s.VLON[v]); }
    out.EVO[i + 1] = vlat.length;
    out.ELEN[i] = s.ELEN[e]; out.ECLS[i] = s.ECLS[e]; out.EELEC[i] = s.EELEC[e]; out.ESPD[i] = s.ESPD[e]; out.EFLG[i] = s.EFLG[e];
    out.ENAME[i] = strings.intern(pack.str(s.ENAME[e])); out.EREF[i] = strings.intern(pack.str(s.EREF[e])); out.ETRK[i] = strings.intern(pack.str(s.ETRK[e]));
  });
  const nN = nodeMap.size;
  out.NLAT = new Int32Array(nN); out.NLON = new Int32Array(nN);
  for (const [old, nw] of nodeMap) { out.NLAT[nw] = s.NLAT[old]; out.NLON[nw] = s.NLON[old]; }
  out.VLAT = Int32Array.from(vlat); out.VLON = Int32Array.from(vlon);
  const deg = new Uint32Array(nN + 1);
  for (let i = 0; i < nE; i++) { deg[out.EFROM[i]]++; deg[out.ETO[i]]++; }
  out.NADJO = new Uint32Array(nN + 1);
  for (let i = 0; i < nN; i++) out.NADJO[i + 1] = out.NADJO[i] + deg[i];
  const fill = out.NADJO.slice(0, nN);
  out.NADJ = new Uint32Array(out.NADJO[nN]);
  for (let i = 0; i < nE; i++) { out.NADJ[fill[out.EFROM[i]]++] = i * 2; out.NADJ[fill[out.ETO[i]]++] = i * 2 + 1; }

  const st = [];
  for (let i = 0; i < pack.stationCount(); i++) {
    if (!keepStation(i, pack)) continue;
    const snaps = [];
    for (let j = s.STSNO[i]; j < s.STSNO[i + 1]; j++) if (edgeMap.has(s.SNEDGE[j])) snaps.push(j);
    st.push({ i, snaps });
  }
  const nS = st.length, nSn = st.reduce((n, x) => n + x.snaps.length, 0);
  Object.assign(out, { STTIP: new Uint32Array(nS), STNAME: new Uint32Array(nS), STLAT: new Int32Array(nS), STLON: new Int32Array(nS), STSNO: new Uint32Array(nS + 1),
    SNEDGE: new Uint32Array(nSn), SNOFF: new Float32Array(nSn), SNDIST: new Float32Array(nSn), SNPLAT: new Uint32Array(nSn), SNLO: new Float32Array(nSn), SNHI: new Float32Array(nSn), SNFLG: new Uint8Array(nSn) });
  let k = 0;
  st.forEach((x, n) => {
    out.STTIP[n] = strings.intern(pack.str(s.STTIP[x.i])); out.STNAME[n] = strings.intern(pack.str(s.STNAME[x.i]));
    out.STLAT[n] = s.STLAT[x.i]; out.STLON[n] = s.STLON[x.i]; out.STSNO[n] = k;
    for (const j of x.snaps) { out.SNEDGE[k] = edgeMap.get(s.SNEDGE[j]); out.SNOFF[k] = s.SNOFF[j]; out.SNDIST[k] = s.SNDIST[j]; out.SNPLAT[k] = strings.intern(pack.str(s.SNPLAT[j])); out.SNLO[k] = s.SNLO[j]; out.SNHI[k] = s.SNHI[j]; out.SNFLG[k] = s.SNFLG[j]; k++; }
  });
  out.STSNO[nS] = k;

  const sg = [];
  if (signals) for (let i = 0; i < s.SGEDGE.length; i++) if (edgeMap.has(s.SGEDGE[i])) sg.push(i);
  Object.assign(out, { SGEDGE: new Uint32Array(sg.length), SGOFF: new Float32Array(sg.length), SGDIST: new Float32Array(sg.length), SGLAT: new Int32Array(sg.length), SGLON: new Int32Array(sg.length), SGREF: new Uint32Array(sg.length), SGDIR: new Uint8Array(sg.length), SGSIDE: new Uint8Array(sg.length), SGKIND: new Uint8Array(sg.length) });
  sg.forEach((i, n) => { out.SGEDGE[n] = edgeMap.get(s.SGEDGE[i]); out.SGOFF[n] = s.SGOFF[i]; out.SGDIST[n] = s.SGDIST[i]; out.SGLAT[n] = s.SGLAT[i]; out.SGLON[n] = s.SGLON[i]; out.SGREF[n] = strings.intern(pack.str(s.SGREF[i])); out.SGDIR[n] = s.SGDIR[i]; out.SGSIDE[n] = s.SGSIDE[i]; out.SGKIND[n] = s.SGKIND[i]; });
  Object.assign(out, strings.build());
  return { sections: out, counts: { edges: nE, nodes: nN, stations: nS, snaps: nSn, signals: sg.length } };
}

module.exports = { cutPack };
