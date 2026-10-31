(function () {
  'use strict';
  var button = document.getElementById('support-copy'), input = document.getElementById('support-address');
  if (!button || !input) return;
  button.addEventListener('click', async function () {
    var status = document.getElementById('support-status');
    try { await navigator.clipboard.writeText(input.value); status.textContent = 'Address copied. Verify it in your wallet before sending SOL.'; }
    catch { input.focus(); input.select(); status.textContent = 'Select and copy the address manually. Verify the recipient before sending SOL.'; }
  });
})();
