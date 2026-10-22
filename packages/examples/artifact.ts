export const examples = [
  {
    slug: 'soft-orbit',
    title: 'Soft orbit',
    topics: ['visual', 'generative', 'animation'],
    color: '#ccd5ff',
    description:
      'A little solar system with absolutely nowhere to be. Move your pointer to bend its orbit.',
    instructions: 'Move your pointer. Click to change the palette.',
  },
  {
    slug: 'tiny-tennis',
    title: 'Tiny tennis',
    topics: ['game', 'arcade'],
    color: '#f6e765',
    description: 'One paddle. One ball. A pleasantly unreasonable amount of determination.',
    instructions: 'Move your pointer or finger to control the paddle.',
  },
  {
    slug: 'plasma-garden',
    title: 'Plasma garden',
    topics: ['visual', 'generative', 'psychedelic'],
    color: '#ffafce',
    description: 'An ever-changing patch of digital flowers. No watering required.',
    instructions: 'Move your pointer to stir the garden. Click for new colors.',
  },
  {
    slug: 'blob-friend',
    title: 'Blob friend',
    topics: ['toy', 'character', 'animation'],
    color: '#c2e4a4',
    description:
      'This little blob is very happy you are here. It follows you around. That is the whole thing.',
    instructions: 'Move your pointer. Click to make your friend jump.',
  },
  {
    slug: 'very-important',
    title: 'Very important button',
    topics: ['meme', 'toy'],
    color: '#ffb586',
    description: 'A deeply unnecessary machine for celebrating very small accomplishments.',
    instructions: 'Click anywhere. You have earned this.',
  },
  {
    slug: 'pixel-rain',
    title: 'Pixel rain',
    topics: ['visual', 'generative', 'pixel-art'],
    color: '#b7dfe7',
    description: 'A pocket-sized weather system, broadcasting from somewhere inside your computer.',
    instructions: 'Move your pointer to change the wind. Click to pause.',
  },
] as const;
export type Example = (typeof examples)[number];

export function exampleHtml(slug: string) {
  if (!examples.some((e) => e.slug === slug)) throw new Error('Unknown example');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${examples.find((e) => e.slug === slug)!.title}</title><style>*{box-sizing:border-box}body{margin:0;overflow:hidden;background:#161822}canvas{display:block;width:100vw;height:100vh;touch-action:none}</style></head><body><canvas aria-label="Interactive canvas. Use your pointer or touch to play."></canvas><script>
const mode=${JSON.stringify(slug)},c=document.querySelector('canvas'),g=c.getContext('2d');let w,h,t=0,mx=.5,my=.5,clicks=0,paused=false,ball={x:.5,y:.3,dx:.003,dy:.004},score=0;
function resize(){w=c.width=innerWidth;h=c.height=innerHeight}resize();addEventListener('resize',resize);
addEventListener('pointermove',e=>{mx=e.clientX/w;my=e.clientY/h});addEventListener('pointerdown',e=>{mx=e.clientX/w;my=e.clientY/h;clicks++;if(mode==='pixel-rain')paused=!paused});
function circle(x,y,r,color){g.fillStyle=color;g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill()}
function text(s,x,y,size,color='#f6eedf'){g.fillStyle=color;g.font='bold '+size+'px monospace';g.textAlign='center';g.fillText(s,x,y)}
function draw(){requestAnimationFrame(draw);if(paused)return;t++;g.fillStyle=mode==='tiny-tennis'?'#f6e765':mode==='blob-friend'?'#c2e4a4':mode==='very-important'?'#ffb586':'#171923';g.fillRect(0,0,w,h);
if(mode==='soft-orbit'){const cx=w/2,cy=h/2,R=Math.min(w,h)*.32;g.save();g.translate(cx,cy);g.rotate(mx*1.2);for(let i=0;i<24;i++){g.strokeStyle='hsla('+(225+i*3+clicks*40)+',80%,80%,.7)';g.beginPath();g.ellipse(0,0,R,Math.max(3,R*Math.abs(Math.sin(i/24*Math.PI+t*.004))),i/24*Math.PI,0,Math.PI*2);g.stroke()}circle(Math.cos(t*.02)*R,Math.sin(t*.02)*R*.45,10,'#ff997a');g.restore()}
if(mode==='plasma-garden'){let s=Math.max(7,Math.floor(w/80));for(let x=0;x<w;x+=s)for(let y=0;y<h;y+=s){let a=Math.sin(x*.015+t*.024)+Math.sin(y*.021-t*.013)+Math.sin(Math.hypot(x-w*mx,y-h*my)*.025-t*.02);g.fillStyle='hsl('+(320+a*35+clicks*55)+',85%,'+(50+a*8)+'%)';g.fillRect(x,y,s,s)}}
if(mode==='tiny-tennis'){g.strokeStyle='#292820';g.lineWidth=2;g.strokeRect(18,18,w-36,h-36);g.setLineDash([6,9]);g.beginPath();g.moveTo(20,h/2);g.lineTo(w-20,h/2);g.stroke();g.setLineDash([]);ball.x+=ball.dx;ball.y+=ball.dy;if(ball.x<.03||ball.x>.97)ball.dx*=-1;if(ball.y<.06)ball.dy=Math.abs(ball.dy);if(ball.y>.87&&ball.y<.94&&Math.abs(ball.x-mx)<.14&&ball.dy>0){ball.dy=-Math.min(.016,ball.dy*1.07);score++}if(ball.y>1){ball={x:.5,y:.3,dx:.003,dy:.004};score=0}g.fillStyle='#27291f';g.fillRect(Math.max(20,Math.min(w-120,mx*w-50)),h*.92,100,10);circle(ball.x*w,ball.y*h,8,'#27291f');text(String(score).padStart(2,'0'),w/2,h*.25,54,'#27291f')}
if(mode==='blob-friend'){const x=w*.5+(mx-.5)*w*.22,y=h*.55+Math.sin(t*.035)*10-Math.abs(Math.sin(clicks+t*.02))*8,r=Math.min(w,h)*.25;g.save();g.translate(x,y);g.scale(1+Math.sin(t*.025)*.04,1-Math.sin(t*.025)*.04);circle(0,0,r,'#4f773f');circle(-r*.28,-r*.17,r*.18,'#fff8e8');circle(r*.28,-r*.17,r*.18,'#fff8e8');circle(-r*.28+(mx-.5)*12,-r*.17+(my-.5)*12,r*.075,'#22341e');circle(r*.28+(mx-.5)*12,-r*.17+(my-.5)*12,r*.075,'#22341e');g.strokeStyle='#22341e';g.lineWidth=5;g.beginPath();g.arc(0,r*.15,r*.22,0,Math.PI);g.stroke();g.restore();text(clicks?'you are doing great.':'oh! hello there.',w/2,h*.9,16,'#314529')}
if(mode==='very-important'){const r=Math.min(w,h)*.23;circle(w/2,h/2+10,r,'#612e31');circle(w/2,h/2,r,'#f0524e');text(clicks?['NICE.','WOW.','ICONIC.','AGAIN?'][clicks%4]:'PRESS ME',w/2,h/2+8,Math.max(16,r*.23));text(clicks+' very important things accomplished',w/2,h*.88,Math.max(11,w*.022),'#582d2a');for(let i=0;i<clicks%30;i++){g.fillStyle=['#ffe96c','#faf2df','#98c8fa'][i%3];g.fillRect((i*97+t*(i%2?1:-1)+w*5)%w,(i*63+t*2)%h,8,12)}}
if(mode==='pixel-rain'){const s=12;for(let i=0;i<95;i++){const x=((i*97+t*(mx-.5)*2)%w+w)%w,y=(i*73+t*(1+i%4))%h;g.fillStyle=['#a1d6df','#b9c3fa','#faadcd','#cce89e'][i%4];g.globalAlpha=.3+(i%7)/10;g.fillRect(Math.floor(x/s)*s,Math.floor(y/s)*s,s-2,(i%3+1)*s-2)}g.globalAlpha=1}}
draw();
</script></body></html>`;
}

export function examplePoster(example: Example) {
  const { slug, color } = example;
  let shapes = '';
  if (slug === 'soft-orbit')
    for (let i = 0; i < 22; i++)
      shapes += `<ellipse cx="360" cy="225" rx="166" ry="${8 + i * 7}" fill="none" stroke="#525899" stroke-width="1.6" transform="rotate(${i * 8} 360 225)"/>`;
  if (slug === 'soft-orbit') shapes += '<circle cx="505" cy="146" r="15" fill="#ff896b"/>';
  if (slug === 'plasma-garden') {
    shapes =
      '<defs><radialGradient id="p"><stop stop-color="#ffec69"/><stop offset=".4" stop-color="#fe7e90"/><stop offset=".7" stop-color="#bb538e"/><stop offset="1" stop-color="#454888"/></radialGradient></defs><rect width="720" height="450" fill="#454888"/>';
    for (let i = 0; i < 6; i++)
      shapes += `<ellipse cx="${60 + i * 130}" cy="${225 + Math.sin(i) * 120}" rx="155" ry="230" fill="url(#p)" transform="rotate(-32 ${60 + i * 130} 225)"/>`;
  }
  if (slug === 'tiny-tennis')
    shapes =
      '<rect x="135" y="44" width="450" height="362" rx="4" fill="none" stroke="#303523" stroke-width="3"/><path d="M135 225H585" stroke="#303523" stroke-width="2" stroke-dasharray="10 12"/><text x="360" y="169" font-size="68" text-anchor="middle" font-family="monospace" fill="#303523">03</text><rect x="307" y="370" width="100" height="12" fill="#303523"/><circle cx="427" cy="282" r="12" fill="#303523"/>';
  if (slug === 'blob-friend')
    shapes =
      '<ellipse cx="361" cy="250" rx="132" ry="128" fill="#547a44"/><ellipse cx="322" cy="220" rx="23" ry="29" fill="#fff8e8"/><ellipse cx="400" cy="220" rx="23" ry="29" fill="#fff8e8"/><circle cx="328" cy="224" r="10" fill="#22341e"/><circle cx="406" cy="224" r="10" fill="#22341e"/><path d="M330 275Q360 311 390 275" fill="none" stroke="#22341e" stroke-width="6" stroke-linecap="round"/><path d="M232 127L213 108M482 121L496 103" stroke="#547a44" stroke-width="5" stroke-linecap="round"/>';
  if (slug === 'very-important')
    shapes =
      '<circle cx="360" cy="243" r="116" fill="#692f31"/><circle cx="360" cy="227" r="116" fill="#f0524e"/><text x="360" y="237" text-anchor="middle" font-family="monospace" font-size="27" font-weight="bold" fill="#fff1df">PRESS ME</text><path d="M172 126L190 151M533 128L510 153M160 262H191M531 259H561" stroke="#803f30" stroke-width="4"/>';
  if (slug === 'pixel-rain') {
    shapes = '<rect width="720" height="450" fill="#232b3c"/>';
    for (let i = 0; i < 65; i++)
      shapes += `<rect x="${(i * 97) % 720}" y="${(i * 73) % 450}" width="13" height="${14 + (i % 3) * 15}" opacity="${0.3 + (i % 7) / 10}" fill="${['#a1d6df', '#b9c3fa', '#faadcd', '#cce89e'][i % 4]}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 450"><rect width="720" height="450" fill="${color}"/>${shapes}</svg>`;
}
