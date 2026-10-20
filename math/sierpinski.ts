import type { Point, Triangle } from "../hpg1/types";

const BOUNDS_MM = [257.5, 191.25]

// Pen .45 mm
// Smallest triangle

function getLargestEquilateralTriangle(W: number, H: number) {
  // Determine maximum possible side length based on rectangle constraints
  const maxHeightSide = (2 * H) / Math.sqrt(3);
  const s = Math.min(W, maxHeightSide);

  // Center the triangle horizontally inside the width W
  const startX = (W - s) / 2;

  // Vertex coordinates
  const p1 = { x: startX, y: H };              // Top-left vertex on top edge
  const p2 = { x: startX + s, y: H };          // Top-right vertex on top edge
  const p3 = { x: W / 2, y: H - (s * Math.sqrt(3)) / 2 }; // Bottom vertex on bottom edge

  return [p1, p2, p3] as Triangle;
}


const triArray1 = getLargestEquilateralTriangle(BOUNDS_MM[0], BOUNDS_MM[1])

function midpoint(pointOne: Point, pointTwo: Point): Point {
      return { 
        x: Math.round((pointTwo.x + pointOne.x) * 100 / 2)/100, 
        y: Math.round((pointTwo.y + pointOne.y) * 100 / 2)/100
      }
}
function gibIkarusSipenski(t: Triangle, maxDepth=1, depth=0): Triangle[] {
    // const pointsAndMids = t.flatMap((point, i) => {
    //   return [point, midpoint(t[i], i === t.length - 1 ? t[0] : t[i + 1])]
    // })

    const outerTris = t.map((point, i) => {
      const pointBefore = i === 0 ? t[t.length-1] : t[i - 1]
      const pointAfter = i === t.length - 1 ? t[0] : t[i + 1]
      return [
        midpoint(pointBefore, point),
        point, 
        midpoint(point, pointAfter)
      ] as Triangle
    })

    const innerTri = t.map((point, i) => {
      const pointAfter = i === t.length - 1 ? t[0] : t[i + 1]
      return midpoint(point, pointAfter)
    }) as Triangle

    const thisDepthTris = [
      ...outerTris,
      innerTri
    ];

    return depth >= maxDepth ? 
      thisDepthTris : 
      [
        ...thisDepthTris,
        ...thisDepthTris.flatMap((tri) => {
          return gibIkarusSipenski(tri, maxDepth, depth+1)
        })
      ]
}

function reverseSorponski(t: Triangle, maxDepth=4, depth=0): Triangle[] {
    const innerTri = t.map((point, i) => {
      const pointAfter = i === t.length - 1 ? t[0] : t[i + 1]
      return midpoint(point, pointAfter)
    }) as Triangle


    return depth >= maxDepth ? 
      [innerTri] : 
      [
        innerTri,
        ...[innerTri].flatMap((tri) => {
          return reverseSorponski(tri, maxDepth, depth+1)
        })
      ]
}

function gibSierpinski(t: Triangle, maxDepth=3, depth=0): Triangle[] {
    const innerTri = t.map((point, i) => {
      const pointAfter = i === t.length - 1 ? t[0] : t[i + 1]
      return midpoint(point, pointAfter)
    }) as Triangle


    const outerTris = t.map((point, i) => {
      const pointBefore = i === 0 ? t[t.length-1] : t[i - 1]
      const pointAfter = i === t.length - 1 ? t[0] : t[i + 1]
      return [
        midpoint(pointBefore, point),
        point, 
        midpoint(point, pointAfter)
      ] as Triangle
    })

    return depth >= maxDepth ? 
      [innerTri] : 
      [
        innerTri,
        ...outerTris.flatMap((tri) => {
          return gibSierpinski(tri, maxDepth, depth+1)
        })
      ]
}

export const allTris = [
  triArray1,
  ...gibSierpinski(triArray1)
]