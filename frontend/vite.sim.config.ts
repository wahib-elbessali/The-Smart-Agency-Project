// Dev server for the live world mock: same as vite.config.ts, plus a browser
// clock that follows the backend's fake clock (tools/sim/run_fake_clock.py),
// so "since 09:12" and "today" match the simulated day.
// Run: npx vite --config vite.sim.config.ts   (see docs/mocking-guide.md)
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config'

const backend = process.env.VITE_DEV_BACKEND ?? 'http://127.0.0.1:8000'

const shim = `(function(){
  var RealDate = Date, offset = 0;
  function sync(){ try {
    var x = new XMLHttpRequest(); x.open('GET','/_sim/clock',false); x.send();
    if (x.status===200) offset = new RealDate(JSON.parse(x.responseText).now).getTime() - RealDate.now();
  } catch(e){} }
  sync(); setInterval(sync, 3000);
  function F(){ var a=arguments;
    if(!(this instanceof F)) return new RealDate(RealDate.now()+offset).toString();
    if(a.length===0) return new RealDate(RealDate.now()+offset);
    return new (Function.prototype.bind.apply(RealDate,[null].concat([].slice.call(a))))();
  }
  F.prototype = RealDate.prototype; F.now=function(){return RealDate.now()+offset};
  F.parse=RealDate.parse; F.UTC=RealDate.UTC; window.Date = F;
})();`

export default mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: 'sim-clock',
        transformIndexHtml: () => [{ tag: 'script', children: shim, injectTo: 'head-prepend' }],
      },
    ],
    server: { proxy: { '/_sim': { target: backend, changeOrigin: true } } },
  }),
)
