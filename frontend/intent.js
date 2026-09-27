(function(root) {
  function parseIntent(raw) {
    let text=String(raw || '').replace(/[’‘]/g,"'").trim().replace(/[.!?]+$/,'').toLowerCase();
    text=text.replace(/^(?:(?:hey(?: there)?|hi|hello|okay|ok|um+|uh+|well|wayfinder)[,\s]+)+/,'').replace(/^please\s+|[,\s]+please$/g,'').trim();
    const commands={stop:'pause',pause:'pause',resume:'resume',repeat:'repeat','say that again':'repeat','got it':'got it','i picked it up':'got it',done:'done',"can't reach it":"can't reach it",'cannot reach it':"can't reach it","i can't reach it":"can't reach it",'too far':'too far',"it's too far":'too far','it is too far':'too far',"i'm too far":'too far','move closer':'too far',closer:'too far','lost it':'lost it',no:'no'};
    if(commands[text]) return {type:'command',command:commands[text]};
    if(!text || /\b(?:not|don't|do not|never|instead of|or|either)\b/.test(text)) return {type:'clarification'};
    const wrappers=[/^(?:(?:can|could|would) (?:you|we)\s+)?(?:please\s+)?(?:help me\s+)?(?:find|locate|look for)\s*/, /^i\s+(?:want|need|would like)(?:\s+you)?\s+to\s+(?:help me\s+)?(?:find|locate|look for)\s*/, /^i(?:'m| am) looking for\s*/, /^where (?:is|are)\s*/, /^(?:what )?i want to find is\s*/];
    for(let i=0;i<3;i++) for(const pattern of wrappers) text=text.replace(pattern,'').trim();
    text=text.replace(/^(?:me\s+)?(?:a|an|the|my|some)\s+/,'').replace(/[,\s]+please$/,'').trim();
    if(/\b(?:do you|should i|can i|could i|would you|will you)\b/.test(text)) return {type:'clarification'};
    if(!text || /^(?:a|an|the|my|some|it|that|this|them|those|these|something|anything|one|find|locate|look for)$/.test(text) || /\b(?:and|or)\b/.test(text) || /^(?:can|could|would|please|help|i)\b/.test(text) || text.length>100) return {type:'clarification'};
    return {type:'target',target:text};
  }
  root.parseIntent=parseIntent;
  if(typeof module!=='undefined') module.exports={parseIntent};
})(typeof window!=='undefined'?window:globalThis);
