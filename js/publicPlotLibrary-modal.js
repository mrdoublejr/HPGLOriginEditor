/* publicPlotLibrary plot explorer for the HPGL Origin Corrector.
   Add to index.html just before the other scripts / </body>:
     <script src="publicPlotLibrary-modal.js" defer></script>
   Drop plot files into the repo's publicPlotLibrary/ folder; they appear automatically.
   Click a thumbnail to load that plot into the corrector. */
(function(){
  var CFG=window.publicPlotLibrary_CONFIG||{};
  var FOLDER=CFG.path||"publicPlotLibrary";
  var EXT=/\.(hpgl|plt|hpg)$/i;          // same types the corrector's file picker accepts
  var MAX_PREVIEW_BYTES=3*1024*1024;     // bigger files: no preview, still clickable
  var MAX_PARALLEL=4;                    // simultaneous preview downloads
  var PENS=["#14243b","#14243b","#c0392b","#1e7a46","#1f5fa8","#8e44ad","#d68910","#7f8c8d","#2c3e50"];

  /* ---------- HPGL preview (IN, SP, PU, PD, PA, PR only) ---------- */
  function parse(text){
    var segs=[],pen=1,down=false,abs=true,x=0,y=0,unsupported=false;
    text.split(/[;\n\r]+/).forEach(function(c){
      c=c.trim(); if(c.length<2) return;
      var op=c.slice(0,2).toUpperCase(),args=c.slice(2);
      if(op==="IN"){pen=1;down=false;abs=true;return}
      if(op==="SP"){pen=parseInt(args,10)||0;return}
      if(op==="PE"){unsupported=true;return}
      if(op==="PA"||op==="PR"||op==="PU"||op==="PD"){
        if(op==="PA")abs=true;else if(op==="PR")abs=false;else down=(op==="PD");
        var n=args.match(/-?\d+(\.\d+)?/g)||[];
        for(var k=0;k+1<n.length;k+=2){
          var nx=parseFloat(n[k]),ny=parseFloat(n[k+1]);
          if(!abs){nx+=x;ny+=y}
          if(down&&pen>0)segs.push([x,y,nx,ny,pen]);
          x=nx;y=ny;
        }
      }
    });
    return {segs:segs,unsupported:unsupported};
  }
  function draw(cv,data){
    var dpr=window.devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;
    cv.width=w*dpr;cv.height=h*dpr;
    var ctx=cv.getContext("2d");ctx.scale(dpr,dpr);
    var s=data.segs;if(!s.length)return false;
    var a=1/0,b=1/0,c=-1/0,d=-1/0;
    s.forEach(function(g){a=Math.min(a,g[0],g[2]);c=Math.max(c,g[0],g[2]);b=Math.min(b,g[1],g[3]);d=Math.max(d,g[1],g[3])});
    var pad=8,bw=(c-a)||1,bh=(d-b)||1,k=Math.min((w-2*pad)/bw,(h-2*pad)/bh),ox=(w-bw*k)/2,oy=(h-bh*k)/2,last=-1;
    ctx.lineWidth=1;ctx.lineCap="round";
    s.forEach(function(g){
      if(g[4]!==last){if(last!==-1)ctx.stroke();ctx.beginPath();ctx.strokeStyle=PENS[g[4]]||PENS[0];last=g[4]}
      ctx.moveTo(ox+(g[0]-a)*k,h-(oy+(g[1]-b)*k));ctx.lineTo(ox+(g[2]-a)*k,h-(oy+(g[3]-b)*k));
    });
    ctx.stroke();return true;
  }

  /* ---------- helpers ---------- */
  function el(t,cls,txt){var e=document.createElement(t);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
  function readJSON(u){return fetch(u).then(function(r){if(!r.ok)throw 0;return r.json()})}
  function nice(n){return n.replace(/\.[^.]+$/,"").replace(/[_-]+/g," ")}
  function url(p){return p.split("/").map(encodeURIComponent).join("/")}
  function kb(n){return n>=1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB"}
  function fmtOf(f){var m=/\.([^./]+)$/.exec(f);return m?m[1].toUpperCase():"OTHER"}

  // Where the file list comes from, in order of preference:
  //  - on github.io: GitHub's API listing of the publicPlotLibrary/ folder
  //  - anywhere else (VS Code Live Server, etc.): the server's directory listing of publicPlotLibrary/
  //  - last resort: publicPlotLibrary/index.json (write it with build-publicPlotLibrary-index.js; may also hold
  //    optional title/plotter/paper/notes per file)
  function makeItem(path,m,size){
    m=m||{};var name=path.split("/").pop();
    return {file:path,title:m.title||nice(name),plotter:m.plotter,paper:m.paper,notes:m.notes,
            format:(m.format||fmtOf(name)).toUpperCase(),size:size!=null?size:m.size};
  }
  function fromGitHub(meta){
    var owner=CFG.owner||location.hostname.split(".")[0];
    var repo=CFG.repo||location.pathname.split("/")[1];
    return readJSON("https://api.github.com/repos/"+owner+"/"+repo+"/contents/"+FOLDER).then(function(files){
      return files.filter(function(f){return f.type==="file"&&EXT.test(f.name)}).map(function(f){
        var path=FOLDER+"/"+f.name;return makeItem(path,meta[path],f.size);
      });
    });
  }
  function fromDirListing(meta){
    return fetch(FOLDER+"/").then(function(r){
      if(!r.ok||!/html/i.test(r.headers.get("content-type")||""))throw 0;return r.text();
    }).then(function(html){
      var doc=new DOMParser().parseFromString(html,"text/html"),seen={},out=[];
      [].forEach.call(doc.querySelectorAll("a[href]"),function(a){
        var raw=(a.getAttribute("href")||"").split("?")[0].split("/").filter(Boolean).pop()||"",name;try{name=decodeURIComponent(raw)}catch(e){name=raw}
        if(EXT.test(name)&&!seen[name]){seen[name]=1;var path=FOLDER+"/"+name;out.push(makeItem(path,meta[path]))}
      });
      if(!out.length)throw 0;return out;
    });
  }
  function getItems(){
    var meta={},onPages=/\.github\.io$/i.test(location.hostname);
    return readJSON(FOLDER+"/index.json").then(function(j){
      var l=j.publicPlotLibrary||[];l.forEach(function(x){meta[x.file]=x});return l;
    }).catch(function(){return []}).then(function(manual){
      var primary=onPages?fromGitHub:fromDirListing;
      return primary(meta).catch(function(){
        return manual.map(function(m){return makeItem(m.file,m)});
      });
    });
  }

  /* ---------- load a publicPlotLibrary into the corrector ---------- */
  function loadIntoCorrector(it,dlg,statusEl){
    var input=document.getElementById("fileInput");
    if(!input){statusEl.textContent="Could not find the corrector's file input.";return}
    statusEl.textContent="Loading "+it.title+"\u2026";
    fetch(url(it.file)).then(function(r){if(!r.ok)throw 0;return r.blob()}).then(function(bl){
      var dt=new DataTransfer();dt.items.add(new File([bl],it.file.split("/").pop(),{type:"text/plain"}));
      input.files=dt.files;
      input.dispatchEvent(new Event("change",{bubbles:true}));
      statusEl.textContent="";dlg.close();window.scrollTo({top:0,behavior:"smooth"});
    }).catch(function(){statusEl.textContent="Could not load that file."});
  }

  /* ---------- UI ---------- */
  var css=
  "#sm-btn,.sm-open{padding:9px 16px;border:0;border-radius:6px;background:#14243b;color:#fff;font:600 14px sans-serif;cursor:pointer}"+
  "#sm-btn{position:fixed;top:12px;right:12px;z-index:50}.sm-open{display:block;margin:10px 0}"+
  "#sm-btn:hover,.sm-open:hover,#sm-btn:focus-visible,.sm-open:focus-visible{background:#1f5fa8}"+
  "#sm-dlg{width:min(1200px,96vw);height:92vh;padding:0;border:1px solid #c3cfd9;border-radius:8px;background:#e7edf1;color:#14243b;font:15px/1.4 'Helvetica Neue',Arial,sans-serif;overflow:hidden}"+
  "#sm-dlg[open]{display:flex;flex-direction:column}#sm-dlg::backdrop{background:rgba(10,20,35,.6)}"+
  ".sm-top{padding:12px 16px;border-bottom:1px solid #c3cfd9;background:#e7edf1}"+
  ".sm-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.sm-row+.sm-row{margin-top:10px}"+
  ".sm-top h2{margin:0;font-size:1.15rem;flex:1}"+
  ".sm-x{border:0;background:none;font-size:1.8rem;line-height:1;cursor:pointer;color:inherit}"+
  ".sm-search{flex:1;min-width:180px;padding:7px 10px;border:1px solid #9fb0bf;border-radius:6px;font:inherit}"+
  ".sm-chip{padding:5px 11px;border:1px solid #9fb0bf;border-radius:999px;background:#fff;color:#14243b;font:inherit;font-size:.85rem;cursor:pointer}"+
  ".sm-chip[aria-pressed=true]{background:#14243b;color:#fff;border-color:#14243b}"+
  ".sm-status{font-size:.85rem;color:#5b6b7e}"+
  "#sm-body{flex:1;overflow:auto;padding:0 16px 20px}"+
  "#sm-body h3{position:sticky;top:0;z-index:2;margin:0;padding:12px 0 8px;background:#e7edf1;font-size:1rem}"+
  ".sm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}"+
  ".sm-card{position:relative;background:#fff;border:1px solid #c3cfd9;border-radius:4px;overflow:hidden}"+
  ".sm-pick{display:block;width:100%;padding:0;border:0;background:none;text-align:left;cursor:pointer;color:#14243b;font:inherit}"+
  ".sm-card:hover,.sm-card:focus-within{border-color:#1f5fa8;box-shadow:0 0 0 2px #1f5fa8}"+
  ".sm-th{aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;border-bottom:1px solid #c3cfd9;"+
    "background:linear-gradient(#e8eef3 1px,transparent 1px) 0 0/20px 20px,linear-gradient(90deg,#e8eef3 1px,transparent 1px) 0 0/20px 20px,#fff}"+
  ".sm-th canvas{width:100%;height:100%;display:block}.sm-th span{font-size:.78rem;color:#5b6b7e;padding:8px;text-align:center}"+
  ".sm-name{padding:6px 8px 7px;font-size:.88rem}.sm-name b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"+
  ".sm-name small{color:#5b6b7e;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"+
  ".sm-dl{position:absolute;top:6px;right:6px;padding:3px 7px;border-radius:4px;background:rgba(20,36,59,.85);color:#fff;font-size:.75rem;text-decoration:none}"+
  ".sm-dl:hover,.sm-dl:focus-visible{background:#1f5fa8}";

  function init(){
    document.head.appendChild(el("style",null,css));

    var btn=document.getElementById("open-publicPlotLibrary");
    if(!btn){
      btn=el("button",null,"Browse public plots");btn.type="button";
      var dz=document.getElementById("dropZone");
      if(dz&&dz.parentNode){btn.className="sm-open";dz.parentNode.insertBefore(btn,dz.nextSibling)}
      else{btn.id="sm-btn";btn.textContent="publicPlotLibrary";document.body.appendChild(btn)}
    }

    var dlg=el("dialog");dlg.id="sm-dlg";dlg.setAttribute("aria-labelledby","sm-title");
    var top=el("div","sm-top"),r1=el("div","sm-row"),r2=el("div","sm-row");
    var t=el("h2",null,"Public plots");t.id="sm-title";
    var status=el("span","sm-status");
    var x=el("button","sm-x","\u00d7");x.type="button";x.setAttribute("aria-label","Close");
    r1.appendChild(t);r1.appendChild(status);r1.appendChild(x);
    var search=el("input","sm-search");search.type="search";search.placeholder="Search by name";search.setAttribute("aria-label","Search sample plots");
    var chips=el("div","sm-row");chips.style.margin="0";
    r2.appendChild(search);r2.appendChild(chips);
    top.appendChild(r1);top.appendChild(r2);
    var body=el("div");body.id="sm-body";
    dlg.appendChild(top);dlg.appendChild(body);document.body.appendChild(dlg);
    x.onclick=function(){dlg.close()};
    dlg.addEventListener("click",function(e){if(e.target===dlg)dlg.close()});

    var built=false,state={fmt:"ALL",q:""},sections=[];
    function applyFilter(){
      var q=state.q.toLowerCase(),shown=0;
      sections.forEach(function(s){
        var any=0;
        s.cards.forEach(function(c){
          var ok=(state.fmt==="ALL"||state.fmt===s.fmt)&&(!q||c.text.indexOf(q)>-1);
          c.node.style.display=ok?"":"none";if(ok)any++;
        });
        s.head.style.display=s.grid.style.display=any?"":"none";shown+=any;
      });
      status.textContent=shown+" plot"+(shown===1?"":"s");
      body.dispatchEvent(new Event("scroll")); // nudge lazy loader
    }
    search.addEventListener("input",function(){state.q=search.value;applyFilter()});

    // preview queue: a few downloads at a time, only for cards that scroll into view
    var queue=[],active=0;
    function pump(){
      while(active<MAX_PARALLEL&&queue.length){active++;(function(job){job(function(){active--;pump()})})(queue.shift())}
    }
    var io=("IntersectionObserver" in window)?new IntersectionObserver(function(es){
      es.forEach(function(e){if(e.isIntersecting){io.unobserve(e.target);queue.push(e.target._job);pump()}})
    },{root:body,rootMargin:"300px"}):null;

    function build(items){
      body.textContent="";
      if(!items.length){body.appendChild(el("p",null,"No sample plots found in the "+FOLDER+" folder yet."));status.textContent="";return}
      var groups={};items.forEach(function(it){(groups[it.format]=groups[it.format]||[]).push(it)});
      var fmts=Object.keys(groups).sort();
      function addChip(label,val,count){
        var c=el("button","sm-chip",label+(count!=null?" ("+count+")":""));c.type="button";c.setAttribute("aria-pressed",val===state.fmt);
        c.onclick=function(){state.fmt=val;[].forEach.call(chips.children,function(k){k.setAttribute("aria-pressed","false")});c.setAttribute("aria-pressed","true");applyFilter()};
        chips.appendChild(c);
      }
      addChip("All","ALL",items.length);fmts.forEach(function(f){addChip(f,f,groups[f].length)});

      fmts.forEach(function(fmt){
        var head=el("h3",null,fmt+" files"),grid=el("div","sm-grid"),sec={fmt:fmt,head:head,grid:grid,cards:[]};
        groups[fmt].sort(function(a,b){return a.title.localeCompare(b.title,undefined,{numeric:true})}).forEach(function(it){
          var card=el("div","sm-card"),pick=el("button","sm-pick");pick.type="button";
          pick.title="Load "+it.title+" into the corrector";
          var th=el("div","sm-th"),cv=document.createElement("canvas");
          cv.setAttribute("role","img");cv.setAttribute("aria-label","Preview of "+it.title);
          th.appendChild(cv);pick.appendChild(th);
          var nm=el("div","sm-name");nm.appendChild(el("b",null,it.title));
          var sub=[it.plotter,it.paper,it.size?kb(it.size):""].filter(Boolean).join(", ");if(sub)nm.appendChild(el("small",null,sub));
          pick.appendChild(nm);card.appendChild(pick);
          var dl=el("a","sm-dl","Download");dl.href=url(it.file);dl.setAttribute("download",it.file.split("/").pop());card.appendChild(dl);
          pick.onclick=function(){loadIntoCorrector(it,dlg,status)};
          grid.appendChild(card);
          sec.cards.push({node:card,text:(it.title+" "+(it.plotter||"")+" "+it.file).toLowerCase()});

          cv._job=function(done){
            if(it.size&&it.size>MAX_PREVIEW_BYTES){th.textContent="";th.appendChild(el("span",null,"Large file, no preview"));done();return}
            fetch(url(it.file)).then(function(r){if(!r.ok)throw 0;return r.text()}).then(function(tx){
              var d=parse(tx);
              if(!draw(cv,d)){th.textContent="";th.appendChild(el("span",null,d.unsupported?"Preview unavailable for this format":"No drawable lines"))}
            }).catch(function(){th.textContent="";th.appendChild(el("span",null,"Preview failed"))}).then(done,done);
          };
          if(io)io.observe(cv);else queue.push(cv._job);
        });
        body.appendChild(head);body.appendChild(grid);sections.push(sec);
      });
      if(!io)pump();
      applyFilter();
    }

    btn.addEventListener("click",function(){
      dlg.showModal();
      if(!built){
        built=true;status.textContent="Loading list\u2026";
        getItems().then(build).catch(function(){status.textContent="";body.textContent="Could not load the sample list."});
      }
    });
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();