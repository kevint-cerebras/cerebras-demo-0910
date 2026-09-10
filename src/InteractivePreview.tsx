import { useEffect, useRef } from 'react';
export type BrowserInput = {type: 'click'; x: number; y: number} | {type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number} | {type: 'key'; key: string} | {type: 'text'; text: string};
export function InteractivePreview({image, title, disabled, interact}: {image: string; title: string; disabled: boolean; interact: (input: BrowserInput)=>Promise<void>}) {
  const ref = useRef<HTMLImageElement>(null);
  const queue = useRef(Promise.resolve());
  const send = (input: BrowserInput) => {
    if (disabled) return;
    queue.current = queue.current.then(()=>interact(input)).catch(()=>{});
  };
  const point = (clientX: number, clientY: number) => {
    const el=ref.current!; const rect=el.getBoundingClientRect();
    const scale=Math.min(rect.width/el.naturalWidth, rect.height/el.naturalHeight);
    const x=(clientX-rect.left-(rect.width-el.naturalWidth*scale)/2)/scale;
    const y=(clientY-rect.top)/scale;
    return x>=0 && y>=0 && x<el.naturalWidth && y<el.naturalHeight ? {x,y} : null;
  };
  useEffect(()=>{
    const el=ref.current!;
    let pending: BrowserInput & {type:'scroll'} | null=null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wheel=(event: WheelEvent)=>{
      event.preventDefault();
      const at=point(event.clientX,event.clientY);
      if(!at || disabled)return;
      const unit=event.deltaMode===1?16:event.deltaMode===2?el.naturalHeight:1;
      if(!pending)pending={type:'scroll',...at,deltaX:0,deltaY:0};
      pending.deltaX+=event.deltaX*unit;pending.deltaY+=event.deltaY*unit;
      if(!timer)timer=setTimeout(()=>{timer=undefined;if(pending)send(pending);pending=null},40);
    };
    el.addEventListener('wheel',wheel,{passive:false});
    return()=>{el.removeEventListener('wheel',wheel);clearTimeout(timer)};
  },[disabled,interact]);
  return <img ref={ref} className="general-preview interactive-preview" src={image} alt={title} tabIndex={disabled?-1:0} aria-label="Interactive agent browser" aria-disabled={disabled} draggable={false}
    title={disabled?'Agent is working':'Click, scroll, or type in the browser'}
    onClick={e=>{const at=point(e.clientX,e.clientY);if(at){e.currentTarget.focus();send({type:'click',...at})}}}
    onKeyDown={e=>{if(disabled || e.metaKey || e.ctrlKey || e.altKey)return;if(e.key.length===1){e.preventDefault();send({type:'text',text:e.key})}else if(['Enter','Backspace','Delete','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key)){e.preventDefault();send({type:'key',key:(e.shiftKey?'Shift+':'')+e.key})}}}
    onPaste={e=>{e.preventDefault();send({type:'text',text:e.clipboardData.getData('text').slice(0,2500)})}} />;
}
