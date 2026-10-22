// Copy to tests/multiplayer.mjs and adapt the UI selectors and observation below.
// Run with: soyli multiplayer tests/multiplayer.mjs --latency 50 --jitter 15
// This scenario is local trusted test code, not part of the sandboxed napplet.
export default async ({ players, check, measure, diagnostics }) => {
  // Replace these selectors with your app's real host/join and readiness UI.
  await players[0].frame.getByRole('button', { name: 'Host game', exact: true }).click();
  await players[1].frame.getByRole('button', { name: 'Join game', exact: true }).click();
  await Promise.all(players.map(player => player.frame.getByText('Connected', { exact: true }).waitFor()));
  check('every player has a connected peer', (await diagnostics()).every(rows => rows.some(p => p.state === 'connected')));

  // Use a DOM observation or a read-only app test probe that reflects RENDERED local state.
  // data-local-x below is an example, not a soyLI or NAP property. For a canvas app,
  // expose rendered coordinates during development or sample its rendered pixels.
  // Do not time keydown itself: that would pass even if the world never moved.
  const milliseconds = await players[1].frame.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    if (!canvas || !canvas.hasAttribute('data-local-x')) throw new Error('Adapt the rendered-state observation to your app.');
    const before = canvas.getAttribute('data-local-x');
    const start = performance.now();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }));
    try {
      await new Promise((resolve, reject) => {
        const poll = () => {
          if (canvas.getAttribute('data-local-x') !== before) resolve();
          else if (performance.now() - start > 2000) reject(new Error('Local player did not move'));
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
      return performance.now() - start;
    } finally {
      canvas.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }));
    }
  });
  measure('guest input to visible movement', milliseconds, 50);
  // Extend with aim/shot feedback, interpolation, authoritative convergence, leave/rejoin,
  // and bad peer messages. One movement assertion does not cover the whole game.
};
