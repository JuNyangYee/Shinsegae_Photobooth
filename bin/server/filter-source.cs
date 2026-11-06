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
    class Part { public object Value; public int Start,End; }
    static readonly Regex Lex = new Regex(@"\s+|//[^\n]*|/\*[\s\S]*?\*/|""(?:\\.|[^""\\])*""|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_$][\w$]*|.",RegexOptions.CultureInvariant);
    static List<Token> Tokens(string text) {
        var result=new List<Token>(); int pos=0;
        foreach(Match m in Lex.Matches(text)) {
            if(m.Index!=pos)throw Bad("unrecognized source token"); pos=m.Index+m.Length;
            if(Char.IsWhiteSpace(m.Value[0])||m.Value.StartsWith("//")||m.Value.StartsWith("/*"))continue;
            result.Add(new Token { V=m.Value,Start=m.Index,End=pos });
        }
        if(pos!=text.Length)throw Bad("truncated token"); return result;
    }
    static object Read(List<Token> ts,ref int i,int depth) {
        if(depth>12||i>10000||i>=ts.Count)throw Bad("literal limit");
        string t=ts[i++].V;
        if(t=="{"||t=="[") {
            bool obj=t=="{"; string end=obj?"}":"]";
            var map=new Dictionary<string,object>(); var list=new List<object>();
            while(i<ts.Count&&ts[i].V!=end) {
                if(obj) {
                    string key=ts[i++].V;
                    if(key.StartsWith("\""))key=(string)Json().DeserializeObject(key);
                    if(!Regex.IsMatch(key,@"^[\w. -]+$")||new[]{"__proto__","constructor","prototype"}.Contains(key)||map.ContainsKey(key))throw Bad("literal key");
                    if(i>=ts.Count||ts[i++].V!=":")throw Bad("literal property");
                    map[key]=Read(ts,ref i,depth+1);
                } else list.Add(Read(ts,ref i,depth+1));
                if(i<ts.Count&&ts[i].V==end)break;
                if(i>=ts.Count||ts[i++].V!=",")throw Bad("literal expression");
            }
            if(i>=ts.Count||ts[i++].V!=end)throw Bad("truncated literal");
            return obj?(object)map:list.ToArray();
        }
        if(t.StartsWith("\""))return Json().DeserializeObject(t);
        if(t=="null")return null;if(t=="true")return true;if(t=="false")return false;
        double n;
        if(Regex.IsMatch(t,@"^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$",RegexOptions.IgnoreCase)&&Double.TryParse(t,NumberStyles.Float,CultureInfo.InvariantCulture,out n)&&!Double.IsInfinity(n))return n;
        throw Bad("unsupported literal");
    }
    static Part Literal(string text,string marker) {
        int at=text.IndexOf(marker,StringComparison.Ordinal);
        if(at<0||text.IndexOf(marker,at+marker.Length,StringComparison.Ordinal)>=0)throw Bad("ambiguous/missing "+marker);
        int offset=at+marker.Length,i=0; var ts=Tokens(text.Substring(offset));
        var value=Read(ts,ref i,0);return new Part {Value=value,Start=offset+ts[0].Start,End=offset+ts[i-1].End};
    }
    static Part Property(string text,string declaration,string key) {
        int at=text.IndexOf(declaration,StringComparison.Ordinal);if(at<0)throw Bad("missing declaration");
        int offset=at+declaration.Length,depth=0;var ts=Tokens(text.Substring(offset));
        for(int i=0;i<ts.Count;i++) {
            string t=ts[i].V;
            if(t==key&&depth==1&&i+2<ts.Count&&ts[i+1].V==":") {
                int start=offset+ts[i+2].Start;var p=Literal("VALUE="+text.Substring(start),"VALUE=");
                return new Part{Value=p.Value,Start=start,End=start+p.End-6};
            }
            if(t=="{"||t=="[")depth++;else if(t=="}"||t=="]") {if(--depth==0)break;}
        }
        throw Bad("missing property "+key);
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
    static string UiSkeleton(string html) {
        int start=html.IndexOf("const PER =",StringComparison.Ordinal),end=start<0?-1:html.IndexOf("</script>",start,StringComparison.Ordinal);
        if(start<0||end<0)throw Bad("settings controller missing");string region=html.Substring(start,end-start);
        foreach(string name in new[]{"PER_DEF","CTRL_BASE","CTRL","TUNE_ROWS","GRADE_ROW","LEVELS"}) {
            string marker="const "+name+" =";int at=region.IndexOf(marker,StringComparison.Ordinal);if(at<0)continue;
            int offset=at+marker.Length,depth=0,stop=-1;var ts=Tokens(region.Substring(offset));
            if(ts.Count==0||(ts[0].V!="{"&&ts[0].V!="["))throw Bad("UI data declaration");
            for(int i=0;i<ts.Count;i++){string v=ts[i].V;if(v=="{"||v=="[")depth++;else if(v=="}"||v=="]")if(--depth==0){stop=i;break;}}
            if(stop<0||stop+1>=ts.Count||ts[stop+1].V!=";")throw Bad("UI data expression");
            region=region.Substring(0,offset+ts[0].Start)+"DATA"+region.Substring(offset+ts[stop].End);
        }
        return Clean(region);
    }
    static void Preset(object p) {
        string[] allowed={"label","sbr","layers","refine","strength","size","boil","fps","grade","level","tune"};
        if(Map(p).Keys.Any(k=>!allowed.Contains(k))||!Equal(Get(p,"sbr"),1d)||Str(Get(p,"label")).Length>100)throw Bad("unsupported preset semantics");
        var tune=Map(Get(p,"tune"));if(tune.Count!=Oil.Length||Oil.Any(k=>!tune.ContainsKey(k)))throw Bad("preset tune keys");
        foreach(var v in tune.Values.Concat(Top.Where(k=>Map(p).ContainsKey(k)).Select(k=>Get(p,k))))if(!(v is double)||Double.IsNaN((double)v)||Double.IsInfinity((double)v))throw Bad("preset number");
    }
    public static string Extract(string module,string html,string baselineJson) {
        if(module.Length>500000||html.Length>800000||!html.TrimEnd().EndsWith("</html>")||!module.TrimEnd().EndsWith("}"))throw Bad("source size/end");
        var meta=Regex.Match(module.Substring(0,Math.Min(module.Length,600)),"\uac24\ub7ec\ub9ac ([0-9a-f]{7,40}) (\\d{4}-\\d{2}-\\d{2})");if(!meta.Success)throw Bad("source version");
        var preset=Property(module,"const PRESETS =","oil2f");Preset(preset.Value);
        var levels=Literal(module,"oil2f: { rows:");var oil=Literal(module,"const OIL = ");var per=Literal(module,"const SLIDER_DEF = ");
        var pd=Literal(ReplaceFirst(module,"...SLIDER_DEF,",""),"const PER_DEF = ").Value;
        object flow=Get(Literal(module,"const CR = ").Value,"tfmE");
        Same(preset.Value,Property(html,"const PRESETS =","oil2f").Value,"preset deployment mismatch");
        Same(levels.Value,Literal(html,"oil2f: { rows:").Value,"level deployment mismatch");
        Same(oil.Value,Literal(html,"const OIL = ").Value,"OIL deployment mismatch");
        Same(per.Value,Literal(html,"const SLIDER_DEF = ").Value,"slider deployment mismatch");
        Same(pd,Literal(ReplaceFirst(html,"...SLIDER_DEF,",""),"const PER_DEF = ").Value,"defaults deployment mismatch");
        Same(flow,Get(Literal(html,"const CR = ").Value,"tfmE"),"flow deployment mismatch");
        string[] oilKeys={"w","len","jit","bump","spec","canvas","refineT","eye","edge","spill","slope","halo"};
        if(Map(oil.Value).Count!=oilKeys.Length||oilKeys.Any(k=>!Map(oil.Value).ContainsKey(k)))throw Bad("OIL structure");
        var rows=Arr(Literal(html,"const TUNE_ROWS = {\n  oil: ").Value);
        if(rows.Any(r=>Arr(r).Length>7||(Arr(r).Length>6&&Arr(r)[6]!=null&&!Equal(Arr(r)[6],"oil2f"))))throw Bad("tune visibility");
        var tune=rows.Concat(new[]{Literal(html,"const GRADE_ROW = ").Value}).ToArray();
        if(tune.Length!=Oil.Length||tune.Select(r=>Str(Arr(r)[0])).Distinct().Count()!=Oil.Length||tune.Any(r=>!Oil.Contains(Str(Arr(r)[0]))))throw Bad("tune controls");
        var ctrlBase=Literal(html,"const CTRL_BASE = ").Value;var ctrl=Property(html,"const CTRL =","oil2f").Value;
        if(Map(ctrl).Keys.Any(k=>!Top.Contains(k)&&k!="note"))throw Bad("unknown control");
        var controls=new List<object>();
        foreach(string k in Top) {
            var raw=Arr(Get(ctrlBase,k));var over=Get(ctrl,k);if(raw.Length!=4||(over!=null&&!(over is object[])))throw Bad("control range");
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
        string fingerprint=Hash(Clean(skeleton)),uiFingerprint=Hash(UiSkeleton(html));
        if(baselineJson!=null) {var baseline=Json().DeserializeObject(baselineJson);Same(fingerprint,Get(baseline,"fingerprint"),"unsupported engine code");Same(uiFingerprint,Get(baseline,"uiFingerprint"),"unsupported settings controller");}
        return Json().Serialize(Obj("schema",1,"meta",Obj("commit",meta.Groups[1].Value,"date",meta.Groups[2].Value,"sha256",Hash(module),"htmlSha256",Hash(html),"bytes",Encoding.UTF8.GetByteCount(module),"source",Url),"fingerprint",fingerprint,"uiFingerprint",uiFingerprint,"controls",controls.ToArray(),"preset",preset.Value,"levels",levels.Value,"flowDefault",flow,"port",port));
    }
}
