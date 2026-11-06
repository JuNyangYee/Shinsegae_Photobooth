// Trusted local parser compiled by Windows PowerShell/.NET. Never executes source JS.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class FilterSourceParser {
    const string Url = "https://nau-filter-gallery.vercel.app/nau-filter/nau-filter.js";
    static readonly string[] Top = {"strength","size","boil","fps","grade","level"};
    static readonly string[] Oil = {"OIL.w.0","OIL.w.1","OIL.w.2","OIL.len","OIL.jit","OIL.bump","OIL.spec","OIL.canvas","OIL.refineT","OIL.eye","OIL.edge","OIL.spill","OIL.slope","OIL.halo","GRADE.keepW"};
    static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength=2097152, RecursionLimit=32 }; }
    static Exception Bad(string why) { return new Exception("review required: " + why); }
    class Token { public string V; public int Start,End; }
    class Part { public object Value; public int Start,End; public string Next; }
    static readonly Regex Lex = new Regex(@"\s+|//[^\n]*|/\*[\s\S]*?\*/|""(?:\\.|[^""\\])*""|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_$][A-Za-z0-9_$]*|.",RegexOptions.CultureInvariant);
    static List<Token> Tokens(string text) {
        var result=new List<Token>(); int pos=0;
        foreach(Match m in Lex.Matches(text)) {
            if(m.Index!=pos)throw Bad("unrecognized source token"); pos=m.Index+m.Length;
            if(Char.IsWhiteSpace(m.Value[0])||m.Value.StartsWith("//")||m.Value.StartsWith("/*"))continue;
            result.Add(new Token { V=m.Value,Start=m.Index,End=pos });
        }
        if(pos!=text.Length)throw Bad("truncated token"); return result;
    }
    static string StringValue(string t) {
        var result=new StringBuilder();string from="\"'\\bfnrt",to="\"'\\\b\f\n\r\t";
        for(int i=1;i<t.Length-1;i++) {
            char c=t[i];if(c!='\\'){if(c<' ')throw Bad("string newline");result.Append(c);continue;}
            c=t[++i];
            if(c=='u'&&i+4<t.Length-1&&Regex.IsMatch(t.Substring(i+1,4),@"^[0-9a-fA-F]{4}$")){result.Append((char)Int32.Parse(t.Substring(i+1,4),NumberStyles.HexNumber));i+=4;}
            else {int at=from.IndexOf(c);if(at<0)throw Bad("unsupported string escape");result.Append(to[at]);}
        }
        return result.ToString();
    }
    static string Key(string t) {if(t.StartsWith("\"")||t.StartsWith("'"))return StringValue(t);if(!Regex.IsMatch(t,@"^[A-Za-z_$][A-Za-z0-9_$]*$"))throw Bad("dynamic/unsupported property key");return t;}
    static void Put(Dictionary<string,object> d,string k,object v) {if(new[]{"__proto__","constructor","prototype"}.Contains(k)||d.ContainsKey(k))throw Bad("duplicate/forbidden property "+k);d[k]=v;}
    static object Reference(List<Token> ts,ref int i,Func<string,object> resolve) {
        if(i>=ts.Count)throw Bad("missing reference");string name=ts[i++].V;
        while(i+1<ts.Count&&ts[i].V=="."&&Regex.IsMatch(ts[i+1].V,@"^[A-Za-z_$]")){i++;name+="."+ts[i++].V;}
        if(resolve==null)throw Bad("reference not allowed");return resolve(name);
    }
    static object Read(List<Token> ts,ref int i,int depth,Func<string,object> resolve) {
        if(depth>12||i>20000||i>=ts.Count)throw Bad("literal limit");string t=ts[i++].V;
        if(t=="{"||t=="[") {
            bool obj=t=="{";string end=obj?"}":"]";var map=new Dictionary<string,object>();var list=new List<object>();
            while(i<ts.Count&&ts[i].V!=end) {
                if(i+2<ts.Count&&ts[i].V=="."&&ts[i+1].V=="."&&ts[i+2].V==".") {
                    i+=3;object value=Reference(ts,ref i,resolve);
                    if(obj){foreach(var pair in Map(value))Put(map,pair.Key,pair.Value);}else list.AddRange(Arr(value));
                } else if(obj) {
                    string key=Key(ts[i++].V);if(i>=ts.Count||ts[i++].V!=":")throw Bad("literal property");Put(map,key,Read(ts,ref i,depth+1,resolve));
                } else list.Add(Read(ts,ref i,depth+1,resolve));
                if(i<ts.Count&&ts[i].V==end)break;if(i>=ts.Count||ts[i++].V!=",")throw Bad("literal expression");
            }
            if(i>=ts.Count||ts[i++].V!=end)throw Bad("truncated literal");return obj?(object)map:list.ToArray();
        }
        if(t.StartsWith("\"")||t.StartsWith("'"))return StringValue(t);
        if(t=="null")return null;if(t=="true")return true;if(t=="false")return false;
        double n;
        if(Regex.IsMatch(t,@"^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$",RegexOptions.IgnoreCase)&&Double.TryParse(t,NumberStyles.Float,CultureInfo.InvariantCulture,out n)&&!Double.IsInfinity(n))return n;
        if(Regex.IsMatch(t,@"^[A-Za-z_$][A-Za-z0-9_$]*$")){i--;return Reference(ts,ref i,resolve);}throw Bad("unsupported literal");
    }
    static Part ReadAt(string text,int offset,Func<string,object> resolve) {
        var ts=Tokens(text.Substring(offset));int i=0;object value=Read(ts,ref i,0,resolve);
        return new Part{Value=value,Start=offset+ts[0].Start,End=offset+ts[i-1].End,Next=i<ts.Count?ts[i].V:null};
    }
    class SourceReader {
        readonly string text;readonly List<Token> ts;
        readonly Dictionary<string,Part> cache=new Dictionary<string,Part>();readonly HashSet<string> pending=new HashSet<string>();
        public SourceReader(string source){text=source;ts=Tokens(source);}
        object Resolve(string name) {
            var path=name.Split('.');if(!new[]{"SLIDER_DEF","NO_MATERIAL","CRAYON_ROWS","CRAYON_NORMAL","CRAYON_FLOW"}.Contains(path[0])||path.Skip(1).Any(k=>k!="set"&&k!="rows"))throw Bad("unsupported static reference "+name);
            object value=Declaration(path[0]).Value;foreach(string key in path.Skip(1)){if(!Map(value).ContainsKey(key))throw Bad("missing static reference");value=Get(value,key);}return value;
        }
        public Part Declaration(string name) {
            Part cached;if(cache.TryGetValue(name,out cached))return cached;if(!pending.Add(name))throw Bad("cyclic reference");
            var matches=new List<int>();for(int i=0;i+3<ts.Count;i++)if(ts[i].V=="const"&&ts[i+1].V==name&&ts[i+2].V=="=")matches.Add(i);
            if(matches.Count!=1)throw Bad("missing/duplicate declaration "+name);
            var p=ReadAt(text,ts[matches[0]+3].Start,Resolve);if(p.Next!=";")throw Bad("expression after declaration "+name);
            pending.Remove(name);cache[name]=p;return p;
        }
        public Part Property(string name,params string[] keys) {
            var p=Declaration(name);
            foreach(string key in keys) {
                if(!Map(p.Value).ContainsKey(key))throw Bad("missing property "+key);
                var sub=Tokens(text.Substring(p.Start,p.End-p.Start));int depth=0;Part found=null;
                for(int i=0;i<sub.Count;i++) {
                    string t=sub[i].V;
                    if(depth==1&&i+2<sub.Count&&sub[i+1].V==":"&&Key(t)==key){found=ReadAt(text,p.Start+sub[i+2].Start,Resolve);break;}
                    if(t=="{"||t=="[")depth++;else if(t=="}"||t=="]")depth--;
                }
                if(found==null)throw Bad("target property must be explicit");p=found;
            }
            return p;
        }
    }
    static Dictionary<string,object> Map(object o) {var d=o as Dictionary<string,object>;if(d==null)throw Bad("object expected");return d;}
    static object[] Arr(object o) {var a=o as object[];if(a==null)throw Bad("array expected");return a;}
    static object Get(object o,string key) {object v;return Map(o).TryGetValue(key,out v)?v:null;}
    static string Str(object o) {if(!(o is string))throw Bad("string expected");return (string)o;}
    static Dictionary<string,object> Obj(params object[] kv) {var d=new Dictionary<string,object>();for(int i=0;i<kv.Length;i+=2)d[(string)kv[i]]=kv[i+1];return d;}
    public static bool Equal(object a,object b) {
        if(a==null||b==null)return a==b;
        var am=a as IDictionary;var bm=b as IDictionary;
        if(am!=null||bm!=null) {
            if(am==null||bm==null||am.Count!=bm.Count)return false;
            foreach(object k in am.Keys)if(!bm.Contains(k)||!Equal(am[k],bm[k]))return false;return true;
        }
        var aa=a as object[];var ba=b as object[];
        if(aa!=null||ba!=null)return aa!=null&&ba!=null&&aa.Length==ba.Length&&aa.Select((x,i)=>Equal(x,ba[i])).All(x=>x);
        if(a is string||b is string||a is bool||b is bool)return a.Equals(b);
        return Convert.ToDouble(a,CultureInfo.InvariantCulture)==Convert.ToDouble(b,CultureInfo.InvariantCulture);
    }
    static void Same(object a,object b,string why) {if(!Equal(a,b))throw Bad(why);}
    static string Hash(string s) {using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(s))).Replace("-","").ToLowerInvariant();}
    static string Clean(string s) {
        return String.Join(" ",Tokens(s).Select(t=>t.V.StartsWith("`")?"`"+Regex.Replace(Regex.Replace(t.V.Substring(1,t.V.Length-2),@"//[^\n]*|/\*[\s\S]*?\*/",""),@"\s+","")+"`":t.V));
    }
    static string ReplaceFirst(string s,string old,string value) {int at=s.IndexOf(old,StringComparison.Ordinal);if(at<0)return s;return s.Substring(0,at)+value+s.Substring(at+old.Length);}
    static string Shader(string source,string name) {
        var t=Tokens(source);
        for(int i=0;i+3<t.Count;i++)if(t[i].V=="const"&&t[i+1].V==name&&t[i+2].V=="=") {
            int j=i+3;while(j<t.Count&&!t[j].V.StartsWith("`")&&t[j].V!=";")j++;
            if(j==t.Count||!t[j].V.StartsWith("`")||t[j].V.Contains("${"))throw Bad("shader structure");
            return t[j].V.Substring(1,t[j].V.Length-2);
        }
        throw Bad("missing shader");
    }
    static string Slot(string s,string a,string b) {int start=s.IndexOf(a,StringComparison.Ordinal),end=start<0?-1:s.IndexOf(b,start+a.Length,StringComparison.Ordinal);if(start<0||end<0)throw Bad("shader slot");return s.Substring(start+a.Length,end-start-a.Length);}
    static string UiSkeleton(string html,SourceReader reader) {
        int start=html.IndexOf("const PER =",StringComparison.Ordinal),end=start<0?-1:html.IndexOf("</script>",start,StringComparison.Ordinal);
        if(start<0||end<0)throw Bad("settings controller missing");string region=html.Substring(start,end-start);
        var cuts=new[]{"PER_DEF","CTRL_BASE","CTRL","TUNE_ROWS","GRADE_ROW","LEVELS"}.Select(n=>reader.Declaration(n)).Where(p=>p.Start>=start&&p.End<=end).OrderByDescending(p=>p.Start);
        foreach(var p in cuts)region=region.Substring(0,p.Start-start)+"DATA"+region.Substring(p.End-start);
        return Clean(region);
    }
    static void AllowedKeys(object value,string[] allowed){if(Map(value).Keys.Any(k=>!allowed.Contains(k)))throw Bad("unknown related property");}
    static void Preset(object p) {
        string[] allowed={"label","sbr","layers","refine","strength","size","boil","fps","grade","level","tune"};
        if(Map(p).Keys.Any(k=>!allowed.Contains(k))||!Equal(Get(p,"sbr"),1d)||Str(Get(p,"label")).Length>100)throw Bad("unsupported preset semantics");
        var tune=Map(Get(p,"tune"));if(tune.Count!=Oil.Length||Oil.Any(k=>!tune.ContainsKey(k)))throw Bad("preset tune keys");
        foreach(var v in tune.Values.Concat(Top.Where(k=>Map(p).ContainsKey(k)).Select(k=>Get(p,k))))if(!Number(v))throw Bad("preset number");
    }
    static bool Number(object value) {
        if(value==null||value is bool||value is string)return false;
        if(!(value is double||value is float||value is int||value is long||value is decimal))return false;
        double n=Convert.ToDouble(value,CultureInfo.InvariantCulture);return !Double.IsNaN(n)&&!Double.IsInfinity(n);
    }
    static double Num(object value){if(!Number(value))throw Bad("finite number expected");return Convert.ToDouble(value,CultureInfo.InvariantCulture);}
    static void Label(object value){if(!(value is string)||((string)value).Length>100)throw Bad("label");}
    static void Bundle(object b) {
        if(!Equal(Get(b,"schema"),1d)||!Equal(Get(Get(b,"meta"),"source"),Url))throw Bad("bundle metadata");
        foreach(string key in new[]{"sha256","htmlSha256"})if(!Regex.IsMatch(Str(Get(Get(b,"meta"),key)),@"^[a-f0-9]{64}$"))throw Bad("source hash");
        if(!Regex.IsMatch(Str(Get(b,"fingerprint")),@"^[a-f0-9]{64}$"))throw Bad("engine fingerprint");
        if(Map(b).ContainsKey("uiFingerprint")&&!Regex.IsMatch(Str(Get(b,"uiFingerprint")),@"^[a-f0-9]{64}$"))throw Bad("UI fingerprint");
        var p=Get(b,"preset");Preset(p);
        var ids=Top.Select(k=>"state."+k).Concat(Oil).Concat(new[]{"state.style"}).ToArray();
        var controls=Arr(Get(b,"controls"));var seen=new HashSet<string>();
        if(controls.Length!=ids.Length)throw Bad("controls count");
        foreach(var c in controls) {
            string id=Str(Get(c,"id"));if(!ids.Contains(id)||!seen.Add(id))throw Bad("control id");Label(Get(c,"label"));
            if(id=="state.style") {
                if(!Equal(Get(c,"kind"),"select")||!new[]{"flat","3d"}.Contains(Str(Get(c,"default"))))throw Bad("style");
                var options=Arr(Get(c,"options"));if(options.Length!=2||!Equal(Get(options[0],"value"),"flat")||!Equal(Get(options[1],"value"),"3d"))throw Bad("style options");
                foreach(var option in options)Label(Get(option,"label"));
            } else {
                if(!Equal(Get(c,"kind"),"number"))throw Bad("control kind");
                double min=Num(Get(c,"min")),max=Num(Get(c,"max")),step=Num(Get(c,"step")),def=Num(Get(c,"default"));
                if(min>=max||min< -100||max>100||step<=0||def<min||def>max)throw Bad("control range");
            }
        }
        double flow=Num(Get(b,"flowDefault"));if(flow<=0||flow>1)throw Bad("flow default");
        string[] slots={"tfmBody","strokeStep","strokeWidth","strokeFns","finishBody","blobFragment","blb"};var port=Map(Get(b,"port"));
        if(port.Count!=slots.Length)throw Bad("shader slot count");
        foreach(string key in slots){string value=Str(Get(port,key));if(String.IsNullOrWhiteSpace(value)||value.Length>30000||Regex.IsMatch(value,@"\x60|\$\{|#extension|#include"))throw Bad("shader slot");}
        var layers=Arr(Get(p,"layers"));if(layers.Length!=3)throw Bad("layer count");
        foreach(var layer in layers)Brush(Arr(layer),6,3);
        Brush(Arr(Get(p,"refine")),5,4);
        string[] rowIds={"state.strength","state.size","OIL.canvas","OIL.jit","CR.nosilw","CR.tfmE"};var rows=Arr(Get(b,"levels"));seen.Clear();
        if(rows.Length!=6)throw Bad("level count");
        foreach(var item in rows){var row=Arr(item);if(row.Length!=4&&row.Length!=7)throw Bad("level row length");string id=Str(row[0]);if(!rowIds.Contains(id)||!seen.Add(id))throw Bad("level id");for(int i=1;i<row.Length;i++){if(i==2&&row[i]==null)continue;double n=Num(row[i]);if(n<0||n>100)throw Bad("level value");}}
    }
    static void Brush(object[] row,int length,int positive) {
        if(row.Length!=length)throw Bad("brush length");
        for(int i=0;i<row.Length;i++){double n=Num(row[i]);if(n<0||n>=200||(i<positive&&n<=0))throw Bad("brush geometry");}
    }
    public static void Validate(string json){Bundle(Json().DeserializeObject(json));}
    public static string Extract(string module,string html,string baselineJson) {
        if(module.Length>500000||html.Length>800000||!html.TrimEnd().EndsWith("</html>")||!module.TrimEnd().EndsWith("}"))throw Bad("source size/end");
        var meta=Regex.Match(module.Substring(0,Math.Min(module.Length,600)),"\uac24\ub7ec\ub9ac ([0-9a-f]{7,40}) (\\d{4}-\\d{2}-\\d{2})");if(!meta.Success)throw Bad("source version");
        var ms=new SourceReader(module);var hs=new SourceReader(html);
        var preset=ms.Property("PRESETS","oil2f");Preset(preset.Value);
        var levels=ms.Property("LEVELS","oil2f","rows");var oil=ms.Declaration("OIL");var per=ms.Declaration("SLIDER_DEF");
        string[] knownState=Top.Concat(new[]{"flat","mood","moodK","normal"}).ToArray();
        foreach(var source in new[]{ms,hs}) {
            AllowedKeys(source.Declaration("PER_DEF").Value,knownState);AllowedKeys(source.Declaration("SLIDER_DEF").Value,new[]{"strength","size","boil"});
            AllowedKeys(source.Property("LEVELS","oil2f").Value,new[]{"rows","normal"});
            var perKeys=Arr(source.Declaration("PER").Value);if(perKeys.Distinct().Count()!=perKeys.Length||perKeys.Any(k=>!(k is string)||!knownState.Contains((string)k)))throw Bad("PER items");
        }
        var pd=ms.Declaration("PER_DEF").Value;
        object flow=Get(ms.Declaration("CR").Value,"tfmE");
        Same(preset.Value,hs.Property("PRESETS","oil2f").Value,"preset deployment mismatch");
        Same(levels.Value,hs.Property("LEVELS","oil2f","rows").Value,"level deployment mismatch");
        Same(oil.Value,hs.Declaration("OIL").Value,"OIL deployment mismatch");
        Same(per.Value,hs.Declaration("SLIDER_DEF").Value,"slider deployment mismatch");
        Same(pd,hs.Declaration("PER_DEF").Value,"defaults deployment mismatch");
        Same(flow,Get(hs.Declaration("CR").Value,"tfmE"),"flow deployment mismatch");
        string[] oilKeys={"w","len","jit","bump","spec","canvas","refineT","eye","edge","spill","slope","halo"};
        if(Map(oil.Value).Count!=oilKeys.Length||oilKeys.Any(k=>!Map(oil.Value).ContainsKey(k)))throw Bad("OIL structure");
        var rows=Arr(hs.Property("TUNE_ROWS","oil").Value);
        if(rows.Any(r=>Arr(r).Length<6||Arr(r).Length>7||(Arr(r).Length>6&&Arr(r)[6]!=null&&!Equal(Arr(r)[6],"oil2f"))))throw Bad("tune visibility");
        var gradeRow=Arr(hs.Declaration("GRADE_ROW").Value);if(gradeRow.Length!=6)throw Bad("grade control row");
        var tune=rows.Concat(new object[]{gradeRow}).ToArray();
        if(tune.Length!=Oil.Length||tune.Select(r=>Str(Arr(r)[0])).Distinct().Count()!=Oil.Length||tune.Any(r=>!Oil.Contains(Str(Arr(r)[0]))))throw Bad("tune controls");
        var ctrlBase=hs.Declaration("CTRL_BASE").Value;var ctrl=hs.Property("CTRL","oil2f").Value;
        AllowedKeys(ctrlBase,Top.Concat(new[]{"flat","moodK"}).ToArray());
        if(Map(ctrl).Keys.Any(k=>!Top.Contains(k)&&k!="note"))throw Bad("unknown control");
        var controls=new List<object>();
        foreach(string k in Top) {
            var raw=Arr(Get(ctrlBase,k));var over=Get(ctrl,k);if(raw.Length!=4||(over!=null&&(!(over is object[])||Arr(over).Length>4)))throw Bad("control range");
            var ov=over as object[];var vals=raw.Select((v,i)=>ov!=null&&ov.Length>i&&ov[i]!=null?ov[i]:v).ToArray();
            controls.Add(Obj("id","state."+k,"kind","number","label",vals[0],"min",vals[1],"max",vals[2],"step",vals[3],"default",Get(preset.Value,k)??Get(pd,k)??Get(per.Value,k)));
        }
        foreach(var item in tune){var r=Arr(item);if(r.Length<6)throw Bad("tune row");controls.Add(Obj("id",r[0],"kind","number","label",r[1],"min",r[2],"max",r[3],"step",r[4],"help",r[5],"default",Get(Get(preset.Value,"tune"),Str(r[0]))));}
        var styleHtml=Regex.Match(html,"<label>([^<]+)</label><select id=\"style\">([\\s\\S]*?)</select>");
        var styleDefault=Regex.Match(module,"style:\\s*\"([^\"]+)\"");if(!styleHtml.Success||!styleDefault.Success)throw Bad("style definition");
        int stateAt=html.IndexOf("const state =",StringComparison.Ordinal),stateEnd=stateAt<0?-1:html.IndexOf("};",stateAt,StringComparison.Ordinal);
        if(stateAt<0||stateEnd<0)throw Bad("style state");var rootStyle=Regex.Match(html.Substring(stateAt,stateEnd-stateAt),"style:\\s*\"([^\"]+)\"");
        string policy="state.style = spec?.style || (SOURCES.find(s => s[1] === path)?.[0].startsWith(\"3D\") ? \"3d\" : \"flat\");";
        if(rootStyle.Success?rootStyle.Groups[1].Value!=styleDefault.Groups[1].Value:!Clean(html).Contains(Clean(policy)))throw Bad("style policy");
        var options=Regex.Matches(styleHtml.Groups[2].Value,"<option value=\"([^\"]+)\">([^<]+)</option>").Cast<Match>().Select(m=>(object)Obj("value",m.Groups[1].Value,"label",m.Groups[2].Value)).ToArray();
        if(String.Join(",",options.Select(o=>Str(Get(o,"value"))))!="flat,3d")throw Bad("style options");
        controls.Add(Obj("id","state.style","kind","select","label",styleHtml.Groups[1].Value,"options",options,"default",styleDefault.Groups[1].Value));
        string vs=Shader(module,"VS_STROKE"),tfm=Shader(module,"FS_TFM"),compose=Shader(module,"FS_COMPOSE"),blob=Shader(module,"FS_BLOB");
        foreach(string name in new[]{"VS_STROKE","FS_TFM","FS_COMPOSE","FS_BLOB"})Same(Clean(Shader(module,name)),Clean(Shader(html,name)),"shader deployment mismatch");
        string path=Slot(vs,"dcur = normalize(mix(dcur, nd, .7));","p += dcur*s; trav += s;");
        int sil=path.IndexOf("uNOSil > 0.",StringComparison.Ordinal),silEnd=sil<0?-1:path.IndexOf('\n',sil);
        int fn=vs.IndexOf("bool spillTo(",StringComparison.Ordinal),fnEnd=fn<0?-1:vs.IndexOf("\n}",fn,StringComparison.Ordinal);
        if(silEnd<0||fnEnd<0)throw Bad("stroke structure");
        var blb=Regex.Match(compose,@"float blb\(vec2 q\)\{[^\n]*?\}");if(!blb.Success)throw Bad("blob function");
        var port=Obj("tfmBody",Slot(tfm,"d2 = vec2(d.x*d.x - d.y*d.y, 2.*d.x*d.y);","vec2 m2 = mix(d2, t2, w);"),"strokeStep",path.Substring(silEnd+1),"strokeWidth",Slot(vs,"float taper = mix(.55, 1., 1. - pow(abs(t)*2., 2.));","gl_Position = vec4(p/uRes*2. - 1., 0., 1.);"),"strokeFns",vs.Substring(fn,fnEnd+2-fn),"finishBody",Slot(compose,"if (uMedium == 1) {","float h0 = texture(uHgt, uv).r"),"blobFragment",blob,"blb",blb.Value);
        string skeleton=module;
        foreach(var c in new[]{preset,levels,oil,per}.OrderByDescending(p=>p.Start))skeleton=skeleton.Substring(0,c.Start)+"DATA"+skeleton.Substring(c.End);
        skeleton=Regex.Replace(skeleton,@"const PER_DEF = \{[^\n]*?\};","const PER_DEF = DATA;");
        skeleton=Regex.Replace(Regex.Replace(skeleton,@"tfmE:\s*[\d.e+-]+","tfmE:DATA"),"style:\\s*\"[^\"]+\"","style:DATA");
        foreach(string key in port.Keys.ToArray()) {string value=Str(port[key]);if(String.IsNullOrWhiteSpace(value))throw Bad("empty shader slot");skeleton=ReplaceFirst(skeleton,value,"SLOT");port[key]=Regex.Replace(Regex.Replace(value,@"\s*&&\s*uMedium == 1\b",""),@"\buMedium == 1\s*&&\s*","");}
        string fingerprint=Hash(Clean(skeleton)),uiFingerprint=Hash(UiSkeleton(html,hs));
        if(baselineJson!=null) {var baseline=Json().DeserializeObject(baselineJson);Same(fingerprint,Get(baseline,"fingerprint"),"unsupported engine code");Same(uiFingerprint,Get(baseline,"uiFingerprint"),"unsupported settings controller");}
        var bundle=Obj("schema",1,"meta",Obj("commit",meta.Groups[1].Value,"date",meta.Groups[2].Value,"sha256",Hash(module),"htmlSha256",Hash(html),"bytes",Encoding.UTF8.GetByteCount(module),"source",Url),"fingerprint",fingerprint,"uiFingerprint",uiFingerprint,"controls",controls.ToArray(),"preset",preset.Value,"levels",levels.Value,"flowDefault",flow,"port",port);
        Bundle(bundle);return Json().Serialize(bundle);
    }
}
