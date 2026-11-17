const test=require('node:test');
const assert=require('node:assert/strict');
const {styleGuides,craftPrinciples,writingDirection}=require('../writing-voice.cjs');

test('writing templates give distinct, operational human-tone directions without a fixed article formula',()=>{
  assert.deepEqual(Object.keys(styleGuides),['自然叙述','温暖治愈','专业理性','轻松幽默','简洁有力']);
  assert.match(craftPrinciples,/不要套用固定的/);
  assert.match(craftPrinciples,/长短句和段落可有变化/);
  assert.match(craftPrinciples,/不强行升华/);
  assert.match(craftPrinciples,/不假装亲历/);
  assert.match(craftPrinciples,/不照搬其句子/);
  for(const style of Object.keys(styleGuides)){
    const direction=writingDirection(style,'article');
    assert.ok(direction.includes(styleGuides[style]),style);
    assert.match(direction,/事实/);
    assert.doesNotMatch(direction,/固定的(?:三|四)段/);
  }
  assert.match(writingDirection('温暖治愈','article'),/不替读者宣布/);
  assert.match(writingDirection('轻松幽默','article'),/不硬造梗/);
  assert.match(writingDirection('自然叙述','outline'),/哪里需要事实支撑/);
  assert.match(writingDirection('专业理性','polish'),/优先小幅编辑/);
});
