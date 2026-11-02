const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script); // Check the entire application, including event wiring.
const context=vm.createContext({TextEncoder,structuredClone,localStorage:{getItem:()=>null},console});
vm.runInContext(script.slice(0,script.indexOf("document.addEventListener('click'")),context);
vm.runInContext(`
let captured;download=(name,bytes,type)=>{captured={name,bytes,type};};notify=()=>{};
rangeStart='2026-10-02';rangeEnd='2026-10-03';search='NO MATCH';filter='재료 외 지출';dayPage=8;
db.store='요요/카페';
db.sales=[{date:'2026-10-01',card:999,cash:0,transfer:0,note:'outside'}, {date:'2026-10-02',card:0,cash:null,transfer:-10,note:'=SUM(A1:A2)'}, {date:'2026-10-03',card:null,cash:null,transfer:null,note:'메모만'}];
db.purchases=[{date:'2026-10-02',group:'월별 구매',vendor:'가게 & <상점>',item:'줄\\n바꿈',amount:-123,note:'@text\\u0001'}];
db.payroll=[{date:'2026-10-02',start:'11:00',end:'18:00',breakMinutes:30,note:'근무'}];
db.monthlyExtras={'2026-10':10000};db.inventory=[{name:'우유',qty:1.5,unit:'L',min:2,cost:2000,supplier:'거래처'}];
db.comparisons={'2026-10':{reported:1000,note:'대조'}};
exportSheets();
`,context);
const captured=vm.runInContext('captured',context);assert(captured);assert.equal(captured.name,'요요_카페_장부_2026-10-02_2026-10-03.xlsx');
assert.match(vm.runInContext("titleHTML('테스트','')",context),/data-action="sheets"/);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cafe-sheet-test-')),file=path.join(dir,'test.xlsx');
try{
 fs.writeFileSync(file,captured.bytes);
 const result=spawnSync('python3',['-c',`
import sys,zipfile,xml.etree.ElementTree as E
n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for name in z.namelist(): E.fromstring(z.read(name))
 wb=E.fromstring(z.read('xl/workbook.xml'))
 assert len(wb.find('s:sheets',n))==10
 def rows(i):
  root=E.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'))
  assert not root.findall('.//s:f',n)
  return [[(''.join(c.itertext()),c.attrib) for c in row] for row in root.findall('s:sheetData/s:row',n)]
 sales=rows(2)
 assert len(sales)==3
 assert sales[1][0][0]=='2026-10-02'
 assert sales[1][2][0]=='0' and sales[1][2][1].get('t') is None
 assert sales[1][3][0]=='' and sales[1][4][0]=='-10'
 assert sales[1][6][0]=='=SUM(A1:A2)' and sales[1][6][1]['t']=='inlineStr'
 assert sales[2][5][0]==''
 purchases=rows(4)
 assert len(purchases)==2 and purchases[1][2][0]=='가게 & <상점>'
 assert purchases[1][3][0]=='줄\\n바꿈' and purchases[1][4][0]=='-123'
 assert purchases[1][5][0]=='@text'
 assert rows(5)[1][5][0]=='6.5' and rows(5)[1][6][0]==''
 assert len(rows(7))==1
 assert rows(8)[1][1][0]=='989' and rows(8)[1][3][0]=='-11'
 assert rows(9)[1][1][0]=='1.5'
 assert rows(10)[6][2][0]=='미확정 · 입력분만 합산'
print('PASS: ZIP/XML, period boundaries, numeric/blank/text cells, Korean, refunds, filters, payroll, monthly comparisons, inventory')
`,file],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);process.stdout.write(result.stdout);
 vm.runInContext("db=seed();exportSheets();",context);assert(vm.runInContext('captured.bytes.length>0',context));
 console.log('PASS: empty ledger export and download button');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
