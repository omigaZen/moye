(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MoyeDocument=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  class DocumentState {
    constructor(){this.load('','');}
    load(raw,canonical){this.text=raw;this.saved=raw;this.canonical=canonical;this.savedCanonical=canonical;this.rawStates=new Map([[canonical,raw]]);}
    observe(canonical){this.canonical=canonical;this.rawStates.set(canonical,this.text);if(this.rawStates.size>80)this.rawStates.delete(this.rawStates.keys().next().value);}
    input(canonical,source=false){if(source){this.text=canonical;this.canonical=canonical;return;}if(canonical===this.canonical)return;this.canonical=canonical;this.text=this.rawStates.has(canonical)?this.rawStates.get(canonical):canonical;}
    save(){this.saved=this.text;this.savedCanonical=this.canonical;this.observe(this.canonical);}
    get dirty(){return this.text!==this.saved;}
  }
  function wordStats(text){
    const clean=text.replace(/```[\s\S]*?```/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/[#*_~`>|\[\]]/g,'');
    let characters=text.length,chinese=0,words=0;
    // Count code points without allocating millions of intermediate entries.
    for(let i=0;i<text.length;i++){
      const c=text.charCodeAt(i);
      if(c>=0xd800&&c<=0xdbff&&i+1<text.length){const next=text.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff){characters--;i++;}}
    }
    for(let i=0;i<clean.length;i++){const c=clean.charCodeAt(i);if(c>=0x3400&&c<=0x9fff||c>=0xf900&&c<=0xfaff)chinese++;}
    const latin=/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;while(latin.test(clean))words++;
    return{characters,words:chinese+words,minutes:Math.max(1,Math.ceil((chinese+words)/350))};
  }
  function literalMatches(text,query){if(!query)return[];const hits=[];let offset=0;while(offset<=text.length-query.length){const at=text.indexOf(query,offset);if(at<0)break;hits.push(at);offset=at+query.length;}return hits;}
  return{DocumentState,wordStats,literalMatches};
});
