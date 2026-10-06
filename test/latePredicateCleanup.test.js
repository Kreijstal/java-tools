'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {shareExistingExitTails:finish}=require('../src/decompiler/cfr')._internals;
const fields={owner:'Game',fields:[{name:'direction',type:'int',static:false},{name:'state',type:'int',static:false},{name:'floating',type:'float',static:false}]};
test('final emission simplifies conditions exposed by shared frame recovery without assuming field values',()=>{
 const body=['Frame:{if(outer()){if(choose()){if(this.state!=0)break Frame;prefix();this.direction=1;if(keep())break Frame;}this.direction=-1;}}'];
 finish(body,[],[],fields);
 assert.equal(body[0],'if(outer()){if(choose()){if (this.state==0) {prefix();this.direction=1;if (!keep()) {this.direction=-1;}}} else {this.direction=-1;}}');
 const numeric=['if(!(this.direction<limit))step();if(!(this.floating<limit))other();if((!!boxed)==identity)identityWork();'];
 finish(numeric,['limit','boxed','identity'],[{name:'limit',type:'int'},{name:'boxed',type:'Boolean'},{name:'identity',type:'Boolean'}],fields);
 assert.equal(numeric[0],'if(this.direction>=limit)step();if(!(this.floating<limit))other();if((!!boxed)==identity)identityWork();');
});
