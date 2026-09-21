// HyperFrames registry component "yt-camera-move" (hyperframes add yt-camera-move): ytCameraMove / ytCameraReset / ytDefocusPulse, vendored verbatim.
(function () {
        window.ytCameraMove = function (tl, target, at, opts) {
          opts = opts || {};
          var dur = opts.dur === undefined ? 1.2 : opts.dur;
          gsap.set(target, {
            transformPerspective: 1200,
            transformOrigin: opts.origin || "50% 50%",
          });
          tl.to(
            target,
            {
              scale: 1 + (opts.zoom === undefined ? 0.11 : opts.zoom),
              x: opts.slideX || 0,
              y: opts.slideY || 0,
              rotationX: opts.tilt || 0,
              rotationY: opts.pan || 0,
              rotation: opts.roll || 0,
              duration: dur,
              ease: opts.ease || "power2.inOut",
            },
            at,
          );
        };
        // Return to rest (same easing family).
        window.ytCameraReset = function (tl, target, at, opts) {
          opts = opts || {};
          tl.to(
            target,
            {
              scale: 1,
              x: 0,
              y: 0,
              rotationX: 0,
              rotationY: 0,
              rotation: 0,
              duration: opts.dur === undefined ? 1.2 : opts.dur,
              ease: opts.ease || "power2.inOut",
            },
            at,
          );
        };
        // Edge-defocus pulse synced to a move (overlay fades in then out).
        window.ytDefocusPulse = function (tl, target, at, dur) {
          dur = dur === undefined ? 1.2 : dur;
          tl.to(target, { opacity: 1, duration: dur * 0.45, ease: "power2.out" }, at);
          tl.to(target, { opacity: 0, duration: dur * 0.55, ease: "power2.in" }, at + dur * 0.45);
        };
})();
