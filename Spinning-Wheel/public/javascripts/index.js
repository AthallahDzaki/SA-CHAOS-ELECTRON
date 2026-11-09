// Global

let WheelSegment = [];
let Queue = [];

// Initialize socket.io

const socket = io.connect();

socket.on('connect', function() {
    console.log('Connected to server');
})

socket.on('disconnect', function() {
    console.log('Disconnected from server');
})

socket.on('message', function(data) {
    data = JSON.parse(data);
    console.log(data);
    if (data.name === "effect") {
        let effect = JSON.parse(data.data);
        effect.forEach((element) => {
            let push = {
                'fillStyle' : "#eae56f",
                'text' : element.name,
                'id' : element.id
            }
            WheelSegment.push(push);
        })
        Init();
        startSpin();
    }
})

let theWheel = null;

function Init() {
    if(theWheel != null) {
        theWheel = null;
    }
    theWheel = new Winwheel({
        'numSegments'  : WheelSegment.length,     // Specify number of segments.
        'outerRadius'  : 212,   // Set outer radius so wheel fits inside the background.
        'textFontSize' : 14,    // Set font size as desired.
        'segments'     : WheelSegment,
        'animation' :           // Specify the animation to use.
        {
            'type'     : 'spinToStop',
            'duration' : 8,     // Duration in seconds.
            'spins'    : 15,     // Number of complete spins.
            'callbackFinished' : (e) => {
                socket.emit('message', JSON.stringify({
                    name: 'effect',
                    data: {
                        id: e.id,
                        name: e.text
                    }
                }));
                setTimeout(() => {
                    resetWheel();
                    wheelSpinning = false;
                }, 10000)
            }
        }
    });
}

let wheelSpinning = false;
function startSpin()
{
    document.getElementById('display').style = '';
    // Ensure that spinning can't be clicked again while already running.
    if (wheelSpinning == false) {

        theWheel.animation.spins = 15;

        // Begin the spin animation by calling startAnimation on the wheel object.
        theWheel.startAnimation();

        // Set to true so that power can't be changed and spin button re-enabled during
        // the current animation. The user will have to reset before spinning again.
        wheelSpinning = true;
    } else {
        Queue.push('spin');
    }
}

function resetWheel()
{
    theWheel.stopAnimation(false);  // Stop the animation, false as param so does not call callback function.
    theWheel.rotationAngle = 0;     // Re-set the wheel angle to 0 degrees.
    theWheel.draw();                // Call draw to render changes to the wheel.
    WheelSegment = [];              // Empty

    // Reset the text to initial state.
    document.getElementById('display').style.display = 'none';
}

setInterval(() => {
    if (Queue.length > 0) {
        if (wheelSpinning == false) {
            Queue.pop();
            fetch('/effect');
        }
    }
}, 1000)