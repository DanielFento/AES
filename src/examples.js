// examples.js
// Curated, beginner-friendly examples.
// Tip: keep examples short. They double as test cases for the transpiler.

(function(){
  "use strict";

  window.AES_EXAMPLES = {
    "Blink (pin variable)": `# Blink an LED (pin 13) forever
pin led is 13

setup:
  make led output
end

loop:
  turn led on
  wait 500 ms
  turn led off
  wait 500 ms
end
`,

    "Button -> LED (pullup)": `# Button on pin 2 (INPUT_PULLUP), LED on pin 13.
# With pullup: pressed = 0, released = 1

pin led is 13
pin button is 2

setup:
  make led output
  make button input pullup
end

loop:
  read button into pressed

  if pressed is 0 do:
    turn led on
  otherwise do:
    turn led off
  end
end
`,

    "Analog -> PWM (pot dimmer)": `# Potentiometer on A0 controls brightness on pin 9

pin pot is A0
pin led is 9

setup:
  make led output
end

loop:
  read analog pot into raw
  map raw from 0..1023 to 0..255 into brightness
  limit brightness to 0..255
  set led to pwm brightness
end
`,

    "Non-blocking blink (every)": `# Blink without delay() using millis() internally

pin led is 13

setup:
  make led output
end

loop:
  every 250 ms do:
    toggle led
  end
end
`,

    "Tone (beep)": `# Simple beep on pin 8

pin buzzer is 8

setup:
  make buzzer output
end

loop:
  play tone 440 on buzzer
  wait 200 ms
  stop tone on buzzer
  wait 800 ms
end
`,
  };
})();
