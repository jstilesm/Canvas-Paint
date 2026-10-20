import HGPL from "./hpg1/commands";
import { hpglToSvg, writeHtmlPreview, openPreview } from "./hpg1/preview";
import { allTris } from "./math/sierpinski";

const BOUNDS = [10300, 7650]
// const center = [Math.floor(BOUNDS[0]/2), Math.floor(BOUNDS[1]/ 2)]
const HPGL = new HGPL({unitsPerMM: 40})

allTris.forEach(tri => HPGL.triangle(tri))
const HPstring = HPGL.serialize();

const svg = hpglToSvg(HPstring);
const previewPath = writeHtmlPreview(svg);
console.log('HPGL String', HPstring)
openPreview(previewPath);