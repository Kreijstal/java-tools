import sys,re,os,collections
d=sys.argv[1]; tot=0; cat=collections.Counter(); lines_total=0; bc=0
# byte-level categories, measured on whole-line basis
rules=[
 ('call region (positional link, PIC, fast call, fallback, post-call protocol)', None),  # handled by region regex
 ('field-cache reset lines', re.compile(r'^\s*ssaFieldCache\d+(?:Valid = false|Object = null|ArrayData = null);\s*$', re.M)),
 ('ssa copies  (x = y;  const x = y;)', re.compile(r'^\s*(?:const |let )?[\w$]+ = [\w$]+;\s*$', re.M)),
 ('array load/store slow paths (null/bounds -> helpers.arrayLoad/Store)', re.compile(r'^.*(?:>>> 0\) >= |helpers\.array(?:Load|Store)\(|ssaMaterializeUnwind).*$', re.M)),
 ('materialize helper definitions', re.compile(r'^function ssaMaterialize\w*\([^)]*\) \{\n(?:.*\n)*?\}\n', re.M)),
 ('safe-point / quantum polling', re.compile(r'^.*(?:safePointBudget|continueStructuredQuantum).*$', re.M)),
 ('comments / markers', re.compile(r'^\s*/\*.*\*/\s*$', re.M)),
 ('blank / braces only', re.compile(r'^\s*[{}]*\s*$', re.M)),
]
region=re.compile(r'/\*__JVM_REGION_CALL_START_(\d+)__\*/.*?/\*__JVM_REGION_CALL_END_\1__\*/', re.S)
calls=0
for f in os.listdir(d):
    s=open(os.path.join(d,f)).read(); n=len(s); tot+=n
    r=region.findall(s); 
    rb=sum(len(m.group(0)) for m in region.finditer(s)); calls+=len(r)
    cat[rules[0][0]]+=rb
    rest=region.sub('',s)
    for name,rx in rules[1:]:
        b=sum(len(m.group(0)) for m in rx.finditer(rest)); cat[name]+=b; rest=rx.sub('',rest)
    cat['everything else']+=len(rest)
print(f"{len(os.listdir(d))} sources, {tot/1e6:.1f} MB, {calls} call regions ({cat[rules[0][0]]/max(calls,1):.0f} B per call region)")
for k,v in cat.most_common(): print(f"  {v/tot*100:5.1f}%  {v/1e6:5.2f} MB  {k}")
