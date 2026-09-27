const test=require('node:test'),assert=require('node:assert/strict');
const {parseIntent}=require('../frontend/intent.js');
for(const [text,target] of [['Could we find the red cup?','red cup'],['Can you help me find a small red cup?','small red cup'],["I'm looking for the cup on the table",'cup on the table'],['Where is the right-hand door?','right-hand door'],['red cup','red cup'],['Hi, please find my keys please.','keys']])test(text,()=>assert.deepEqual(parseIntent(text),{type:'target',target}));
for(const text of ['', 'find', 'find a', 'find it', 'find those', 'Find the cup or bottle', "Don't find the cup", 'Find a cup and a bottle'])test('clarify '+text,()=>assert.equal(parseIntent(text).type,'clarification'));
for(const text of ['pause','stop','resume','repeat','got it','too far'])test('command '+text,()=>assert.equal(parseIntent(text).type,'command'));

test("trailing conversation is not included in the target",()=>assert.equal(parseIntent("I am looking for a red cup Do you want me to move").type,"clarification"));
