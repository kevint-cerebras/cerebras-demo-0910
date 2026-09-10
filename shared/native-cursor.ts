// Presentation only. No browser actions or model decisions depend on this cursor.
export const nativeCursorScript = `(() => {
  let root, pointer;
  window.addEventListener('dash:cursor', event => {
    const point = event.detail;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (!root || !root.isConnected) {
      root = document.createElement('div');
      root.id = 'dash-native-cursor';
      root.setAttribute('aria-hidden', 'true');
      root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:visible;';
      const shadow = root.attachShadow({mode:'closed'});
      shadow.innerHTML = '<style>:host{pointer-events:none}#pointer{position:fixed;left:0;top:0;transition:transform 95ms linear;pointer-events:none;filter:drop-shadow(1px 2px 2px #0002)}svg{display:block;width:27px;height:30px}span{position:absolute;left:19px;top:26px;background:#ee7453;color:#fff8ec;font:500 10px/1.1 sans-serif;padding:5px 7px;border-radius:5px;white-space:nowrap}</style><div id="pointer"><svg viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 25 18l-11 1-5 10z" fill="#ee7453" stroke="#fff8ef" stroke-width="2" stroke-linejoin="round"/></svg><span>dash</span></div>';
      pointer = shadow.getElementById('pointer');
      document.documentElement.appendChild(root);
    }
    setTimeout(() => { if (pointer) pointer.style.transform = 'translate(' + point.x + 'px,' + point.y + 'px)'; }, 100);
  });
})();`;
