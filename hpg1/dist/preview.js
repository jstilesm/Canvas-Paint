var test = 'IN;SP4;PA 8000,4000;PD;PA 8000,4000;PA 7414,5414;PA 6000,6000;PA 4586,5414;PA 4000,4000;PA 4586,2586;PA 6000,2000;PA 7414,2586;PA 8000,4000;PU;';
var BOUNDS = [10300, 7650];
function commandsToSegments(hpgl) {
    var commands = hpgl.split(";");
    var pos = { x: 0, y: 0 };
    var penDown = false;
    var segments = [];
    for (var _i = 0, commands_1 = commands; _i < commands_1.length; _i++) {
        var command = commands_1[_i];
        var initial = command.slice(0, 2);
        var coords = command.slice(3).split(",");
        // console.log('command:', initial)
        // console.log('coordinates:', coords)
        if (initial === "PU") {
            penDown = false;
            continue;
        }
        if (initial === "PD") {
            penDown = true;
            continue;
        }
        var prev = { x: pos.x, y: pos.y };
        if (initial === "PA") {
            pos.x = Number(coords[0]);
            pos.y = Number(coords[1]);
            if (penDown)
                segments.push({ x1: prev.x, y1: prev.y, x2: pos.x, y2: pos.y });
        }
        if (initial === "PR") {
            pos.x = pos.x + Number(coords[0]);
            pos.y = pos.y + Number(coords[1]);
        }
    }
    return segments;
}
// TO DO
// fs.writeFileSync(path.join(os.tmpdir(), 'plot.svg'), svgString)
commandsToSegments(test);
// generate svg from line coordinates
function dot() { }
