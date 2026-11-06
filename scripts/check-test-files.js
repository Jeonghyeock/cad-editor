// test:unit 이 돌 테스트 파일(test/*.test.ts)이 하나도 없으면 실패한다.
// node --test 는 글롭에 맞는 파일이 0개여도 exit 0 이라, test/ 가 옮겨지거나 글롭이 틀어지면 '0건 통과'로 지나간다.
// CI 만이 아니라 로컬의 npm test 에서도 같게 막으려고 test:unit 스크립트 앞에 둔다.
const fs = require("fs");
const path = require("path");

const testDir = path.join(__dirname, "..", "test");
const files = fs.existsSync(testDir)
  ? fs.readdirSync(testDir).filter((name) => name.endsWith(".test.ts"))
  : [];

if (files.length === 0) {
  console.error("test/*.test.ts 에 맞는 테스트 파일이 없습니다.");
  process.exit(1);
}
