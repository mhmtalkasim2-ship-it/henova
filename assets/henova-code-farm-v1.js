/* HENOVA owner-only native SVG farm. No raster images, external assets or emoji scene elements. */
(function(){
'use strict';
var seed=8541;
function rnd(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}
function f(v){return Number(v).toFixed(1);}
function tag(n,a,b){return '<'+n+(a?' '+a:'')+'>'+(b||'')+'</'+n+'>';}
function ell(x,y,rx,ry,fill,extra){return '<ellipse cx="'+f(x)+'" cy="'+f(y)+'" rx="'+f(rx)+'" ry="'+f(ry)+'" fill="'+fill+'" '+(extra||'')+'/>';}
function circ(x,y,r,fill,extra){return '<circle cx="'+f(x)+'" cy="'+f(y)+'" r="'+f(r)+'" fill="'+fill+'" '+(extra||'')+'/>';}
function path(d,fill,extra){return '<path d="'+d+'" fill="'+fill+'" '+(extra||'')+'/>';}
function group(trans,body,extra){return tag('g','transform="'+trans+'" '+(extra||''),body);}
function flower(x,y,s,color){
 var p='';
 for(var i=0;i<6;i++){var a=i*Math.PI/3;p+=ell(x+Math.cos(a)*s*2.2,y+Math.sin(a)*s*1.8,s*1.5,s*.97,color,'opacity=".95" transform="rotate('+f(i*60)+' '+f(x+Math.cos(a)*s*2.2)+' '+f(y+Math.sin(a)*s*1.8)+')"');}
 p+=circ(x,y,s,'#f8d764')+circ(x-s*.2,y-s*.2,s*.35,'#fff7c0');
 return p;
}
function grass(){
 var s='';
 for(var i=0;i<520;i++){
  var x=rnd()*650,y=65+rnd()*1090,h=2+rnd()*8;
  s+=path('M'+f(x)+' '+f(y)+' q-3 -'+f(h)+' -2 -'+f(h+2)+' M'+f(x)+' '+f(y)+' q3 -'+f(h)+' 3 -'+f(h+1),'none','stroke="'+(rnd()>.52?'#c1da55':'#245d26')+'" stroke-width="'+f(.45+rnd()*.9)+'" opacity="'+f(.18+rnd()*.38)+'"');
 }
 return s;
}
function blossomFields(){
 var out='';
 for(var i=0;i<105;i++){
  var x=15+rnd()*630,y=25+rnd()*1100;
  if((x>155&&x<305&&y>690)||y>1110)continue;
  out+=flower(x,y,1+rnd()*1.45,['#fff8e9','#f9d1db','#e6e9aa','#fcbdce'][Math.floor(rnd()*4)]);
 }
 return out;
}
function tree(x,y,s,number){
 var out='<g transform="translate('+x+' '+y+') scale('+s+')">';
 out+=ell(0,8,70,17,'#163b17','opacity=".23"');
 out+=path('M-13 1 Q-8 -55 -15 -116 Q-33 -157 -22 -179 L-13 -175 L-4 -130 L12 -179 L25 -176 L9 -123 L14 1 Z','url(#bark)','stroke="#694219" stroke-width="3"');
 out+=path('M-12 -133 Q-28 -155 -50 -158 M0 -145 Q32 -171 51 -172','none','stroke="#72542e" stroke-width="9" stroke-linecap="round"');
 for(var i=0;i<27;i++){
  var a=i*2.399,rad=Math.sqrt((i+.8)/27),lx=Math.cos(a)*76*rad,ly=-171+Math.sin(a)*48*rad;
  var rr=28+12*rnd();
  out+=ell(lx,ly,rr,rr*.77,['url(#leafBright)','url(#leafDeep)','url(#leafMid)'][i%3],'opacity=".96"');
 }
 for(var j=0;j<68;j++){
  var ax=(rnd()-.5)*156,ay=-172+(rnd()-.5)*100;
  if((ax*ax)/(88*88)+(ay+166)*(ay+166)/(66*66)>1.1)continue;
  out+=ell(ax,ay,2.1+rnd()*4.2,1.4+rnd()*2.5,rnd()>.4?'#9fc746':'#276729','opacity="'+f(.55+rnd()*.35)+'" transform="rotate('+f(rnd()*180)+' '+f(ax)+' '+f(ay)+')"');
 }
 for(var k=0;k<17;k++){
  var px=(rnd()-.5)*134,py=-168+(rnd()-.5)*86;
  if((px*px)/(80*80)+(py+166)*(py+166)/(60*60)>1)continue;
  out+=circ(px,py,4+rnd()*2.2,'url(#apple)','stroke="#8e2a16" stroke-width=".7"');
  out+=path('M'+f(px)+' '+f(py-4)+' l1 -4','none','stroke="#523f19" stroke-width="1.4"');
  out+=ell(px+2,py-2,1.2,2,'#ffe2a6','opacity=".75"');
 }
 out+='</g>';
 return out;
}
function fence(){
 var o='<g stroke-linejoin="round">';
 for(var i=0;i<8;i++){
  var x=280+i*54;
  o+=path('M'+x+' 593 L'+x+' 526 L'+(x+10)+' 512 L'+(x+21)+' 528 L'+(x+21)+' 595 Z','url(#wood)','stroke="#92672b" stroke-width="2"');
 }
 o+=path('M280 540 Q440 539 650 533 L650 546 L280 553 Z','url(#wood)');
 o+=path('M280 571 Q444 569 650 561 L650 574 L280 585 Z','url(#wood)');
 o+='</g>';return o;
}
function coop(){
 var s='<g filter="url(#softShadow)">';
 s+=ell(133,702,165,27,'#21441f','opacity=".25"');
 s+=path('M-12 454 L219 420 L282 520 L280 694 L-7 706 Z','url(#redPlanks)','stroke="#8e391c" stroke-width="6"');
 for(var i=0;i<8;i++){
  var xx=i*37-10;
  s+=path('M'+xx+' 486 L'+xx+' 697','none','stroke="#7b2b15" stroke-width="2" opacity=".58"');
  s+=path('M'+(xx+5)+' 487 L'+(xx+5)+' 690','none','stroke="#ffd5a1" stroke-width="1" opacity=".28"');
 }
 s+=path('M-37 507 L73 389 L188 370 L307 501 L279 511 L174 415 L59 523 Z','url(#roof)','stroke="#3e291b" stroke-width="7"');
 for(var k=0;k<5;k++)s+=path('M'+(-24+k*20)+' '+(498-k*16)+' L'+(70+k*25)+' '+(392-k*4),'none','stroke="#b78f5b" stroke-width="2.7" opacity=".6"');
 s+=path('M45 516 L183 411 L284 520','none','stroke="#f6dcad" stroke-width="13" stroke-linejoin="round"');
 s+=path('M48 520 L181 420 L279 527','none','stroke="#432719" stroke-width="4"');
 s+=ell(176,470,19,24,'#ede7cb','stroke="#613e28" stroke-width="7"');
 s+=ell(176,470,12,16,'#2a2c20');
 s+=path('M114 696 L114 585 Q114 536 164 532 Q211 530 211 579 L211 693 Z','#ead5a8','stroke="#82432a" stroke-width="6"');
 s+=path('M127 688 L127 582 Q127 549 163 546 Q198 550 198 585 L198 688 Z','url(#door)','stroke="#4d2817" stroke-width="3"');
 s+=path('M128 663 Q150 645 197 664 L197 690 L128 688 Z','#d2a14e','opacity=".88"');
 s+=ell(206,611,3,5,'#fee09e');
 s+=path('M115 680 L201 680 L234 748 L94 752 Z','url(#wood)','stroke="#6e482b" stroke-width="5"');
 for(var j=0;j<5;j++)s+=path('M'+(112-j*4)+' '+(692+j*12)+' L'+(208+j*5)+' '+(692+j*12),'none','stroke="#422719" stroke-width="7" stroke-linecap="round"');
 s+=path('M20 678 L20 710 M255 676 L255 701','none','stroke="#76522c" stroke-width="11"');
 s+='</g>';return s;
}
function windmill(){
 var s='<g filter="url(#softShadow)">';
 s+=ell(558,674,89,19,'#1d4429','opacity=".28"');
 s+=path('M516 661 L533 432 L594 432 L624 657 Z','url(#stone)','stroke="#766c5b" stroke-width="6"');
 // masonry
 for(var row=0;row<7;row++){
  var yy=459+row*29;
  s+=path('M'+f(532-row*2)+' '+yy+' L'+f(604+row*2)+' '+yy,'none','stroke="#897f6d" stroke-width="2" opacity=".6"');
  for(var z=0;z<3;z++)s+=path('M'+f(542+z*25+(row%2)*12)+' '+yy+' l-2 28','none','stroke="#80715e" stroke-width="2" opacity=".55"');
 }
 s+=path('M519 439 L543 389 L594 394 L624 449 Z','url(#roof)','stroke="#68311c" stroke-width="5"');
 s+=path('M544 654 L546 599 Q547 568 576 570 Q600 574 601 609 L602 656 Z','url(#door)','stroke="#ead5aa" stroke-width="8"');
 s+=path('M552 653 L552 604 Q554 582 575 583 Q592 585 592 605 L594 653 Z','url(#wood)','stroke="#68452a" stroke-width="3"');
 s+=circ(581,617,3,'#f6d680');
 s+=path('M565 520 L565 495 Q578 484 589 498 L590 525 Z','#292d29','stroke="#d5c3a2" stroke-width="5"');
 s+='</g>';
 // actual moving coded rotor, not a drawn texture
 s+='<g transform="translate(568 456)"><g class="hv-rotor">';
 for(var b=0;b<4;b++){
   s+=group('rotate('+(b*90)+')',path('M-7 -10 L-22 -137 L9 -143 L16 -12 Z','url(#blade)','stroke="#895228" stroke-width="4"')
    +path('M-12 -112 L5 -114 M-10 -83 L7 -84 M-8 -53 L10 -55','none','stroke="#c98c46" stroke-width="4"')
    +path('M-17 -125 L9 -130','none','stroke="#fff6c8" stroke-width="2" opacity=".65"'));
 }
 s+=circ(0,0,22,'url(#wood)','stroke="#75371b" stroke-width="6"')+circ(0,0,9,'url(#gold)');
 s+='</g></g>';
 return s;
}
function pebbles(){
 var s='';
 for(var i=0;i<38;i++){
  var y=745+rnd()*410,x=217+(rnd()-.5)*(34+(y-745)*.12);
  s+=ell(x,y,2+rnd()*6,1.2+rnd()*3,['#c7a987','#ac8e67','#e2c49a'][i%3],'opacity=".7" transform="rotate('+f(rnd()*180)+' '+f(x)+' '+f(y)+')"');
 }
 return s;
}
function pathwalk(){
 return path('M138 680 Q207 670 234 714 Q265 748 257 814 Q235 931 300 1157 L105 1157 Q200 929 167 825 Q152 747 138 680 Z','url(#sand)','stroke="#d6ae77" stroke-width="5"')+pebbles();
}
function hay(x,y,s){
 var o=group('translate('+x+' '+y+') scale('+s+')',ell(0,22,69,19,'#173e17','opacity=".3"')+
 path('M-56 -28 L32 -34 L70 -8 L64 33 L-45 37 L-61 8 Z','url(#hay)','stroke="#bd7e2b" stroke-width="4"')+
 path('M32 -34 L71 -7 L62 32 L32 12 Z','#cc8b27','opacity=".7"')+
 path('M-54 3 L64 0 M-50 24 L60 23','none','stroke="#eecb64" stroke-width="3"')+
 path('M-20 -34 L-15 35 M20 -34 L25 35','none','stroke="#a76a24" stroke-width="4"'));
 return o;
}
function nest(){
 var o=ell(43,745,70,33,'#8c6b29','stroke="#edc04f" stroke-width="8"');
 for(var i=0;i<29;i++){var a=rnd()*Math.PI*2,rr=22+rnd()*46;o+=path('M'+f(43+Math.cos(a)*rr)+' '+f(745+Math.sin(a)*rr*.44)+' l'+f((rnd()-.5)*16)+' '+f((rnd()-.5)*14),'none','stroke="'+(rnd()>.5?'#f4d575':'#c89830')+'" stroke-width="3"');}
 o+=ell(19,741,13,19,'url(#egg)','transform="rotate(-19 19 741)"');
 o+=ell(46,734,14,20,'url(#egg)','transform="rotate(17 46 734)"');
 o+=ell(69,744,12,18,'url(#egg)','transform="rotate(30 69 744)"');
 return o;
}
function feeder(){
 var o='<g transform="translate(552 686)">';
 o+=path('M-12 -11 L106 -8 L121 29 L1 29 Z','url(#wood)','stroke="#914e22" stroke-width="5"');
 o+=path('M-2 -8 L102 -8 L111 15 L5 14 Z','url(#corn)');
 for(var i=0;i<43;i++){var x=4+rnd()*95,y=-7+rnd()*20;o+=circ(x,y,1+rnd()*2,'#edac33');}
 o+=path('M9 28 L3 74 M104 28 L111 74','none','stroke="#85441d" stroke-width="9" stroke-linecap="round"');
 return o+'</g>';
}
function stones(){
 var out='';
 for(var i=0;i<25;i++){
  var a=i*Math.PI*2/25,radx=114,rady=66,x=545+Math.cos(a)*radx,y=904+Math.sin(a)*rady+9,sz=18+rnd()*8;
  out+=path('M'+f(x-sz)+' '+f(y)+' l'+f(sz*.5)+' -'+f(sz*.85)+' l'+f(sz)+' -'+f(sz*.4)+' l'+f(sz*.68)+' '+f(sz*.7)+' l-'+f(sz*.4)+' '+f(sz*.8)+' Z','url(#rock)','stroke="#69645a" stroke-width="2"');
 }
 return out;
}
function pond(){
 var s=ell(545,906,106,62,'#223a2d','opacity=".35"');
 s+=ell(545,899,103,58,'url(#water)','stroke="#477b70" stroke-width="5"');
 for(var i=0;i<3;i++)s+=ell(549,906,18+i*23,8+i*14,'none','stroke="#a8f7f4" stroke-width="2" opacity="'+f(.6-i*.13)+'"');
 s+=stones();
 s+=path('M548 885 Q541 856 546 830 Q552 823 551 817 M556 887 Q558 868 563 856 M542 878 Q537 862 533 853','none','stroke="#d5ffff" stroke-width="5" stroke-linecap="round" opacity=".94"');
 s+=path('M549 837 Q545 852 541 864 Q538 873 550 885','none','stroke="#52a6e5" stroke-width="6" opacity=".7"');
 s+='<g><ellipse cx="549" cy="904" rx="6" ry="3" fill="#ffffff" opacity=".9"><animate attributeName="rx" values="3;43;3" dur="2.8s" repeatCount="indefinite"/><animate attributeName="opacity" values=".85;0;.85" dur="2.8s" repeatCount="indefinite"/></ellipse></g>';
 s+=flower(627,910,4,'#f8a6d4')+flower(479,887,3,'#f9c9e8');
 return s;
}
function bush(x,y,s){
 var o=ell(x,y,42*s,13*s,'#214b1e','opacity=".23"');
 for(var i=0;i<12;i++){
  var ax=x+(rnd()-.5)*55*s,ay=y-9*s+(rnd()-.5)*28*s;
  o+=ell(ax,ay,(15+rnd()*8)*s,(11+rnd()*5)*s,['url(#leafBright)','url(#leafDeep)','url(#leafMid)'][i%3]);
 }
 for(var j=0;j<10;j++)o+=flower(x+(rnd()-.5)*51*s,y-20*s+(rnd()-.5)*21*s,2.1*s,['#f5b3c6','#fff6ee','#f691b8'][j%3]);
 return o;
}
function chicken(x,y,scale,color,delay,period){
 var white=color==='white',body=white?'url(#feathersWhite)':'url(#feathersGold)',wing=white?'#ece9da':'#e7ae5d';
 var s='<g transform="translate('+x+' '+y+') scale('+scale+')">';
 s+='<g class="hv-chicken-walk" style="animation-delay:-'+delay+'s;animation-duration:'+period+'s">';
 s+=ell(0,45,44,9,'#244524','opacity=".25"');
 // animated feet, beak and tail are made from code.
 s+=path('M-16 25 L-17 46 L-27 50 M-17 46 L-7 52 M16 25 L19 47 L31 50 M19 47 L9 51','none','stroke="#c2702b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"');
 s+='<g class="hv-chicken-tail">'+path('M-27 -12 Q-61 -19 -58 -52 Q-48 -48 -43 -26 Q-55 -58 -43 -65 Q-22 -44 -21 -21 Z',wing,'stroke="'+(white?'#c9c2b8':'#af743c')+'" stroke-width="2"')+'</g>';
 s+=ell(-4,-9,36,35,body,'stroke="'+(white?'#c1c0b2':'#b87d46')+'" stroke-width="2"');
 s+=ell(-14,-10,18,21,wing,'stroke="'+(white?'#bebeb6':'#bd894f')+'" stroke-width="2"');
 s+=path('M-28 -15 Q-9 -27 2 -7 Q-12 9 -31 1','none','stroke="'+(white?'#c5bfb0':'#bf8949')+'" stroke-width="2"');
 s+='<g class="hv-chicken-head">';
 s+=ell(18,-34,26,29,body);
 s+=path('M8 -59 Q3 -77 15 -76 Q22 -73 20 -64 Q24 -82 33 -75 Q39 -68 29 -59','#d72c21','stroke="#a72417" stroke-width="1.5"');
 s+=ell(29,-38,5.3,7,'#fffaf3')+circ(30.2,-38.5,2.9,'#18191a')+circ(31.5,-40.5,1.05,'#fff');
 s+=path('M41 -24 L62 -19 L43 -12 Z','url(#beak)','stroke="#b46a28" stroke-width="1"');
 s+=path('M30 -12 Q24 -5 34 6 Q44 -2 40 -15','#d72b26','stroke="#ae211c" stroke-width="1.4"');
 s+='</g></g></g>';return s;
}
function scene(){
 seed=8541;
 var defs='<defs>'
 +'<linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#80b73a"/><stop offset=".48" stop-color="#5ba32d"/><stop offset="1" stop-color="#478b24"/></linearGradient>'
 +'<radialGradient id="leafBright" cx=".31" cy=".19" r=".87"><stop stop-color="#d4e15c"/><stop offset=".34" stop-color="#5d9c29"/><stop offset="1" stop-color="#245b21"/></radialGradient>'
 +'<radialGradient id="leafDeep" cx=".3" cy=".24" r=".9"><stop stop-color="#8abe39"/><stop offset=".42" stop-color="#3d8027"/><stop offset="1" stop-color="#19471d"/></radialGradient>'
 +'<radialGradient id="leafMid" cx=".26" cy=".15" r=".92"><stop stop-color="#c1cf42"/><stop offset=".5" stop-color="#4e9127"/><stop offset="1" stop-color="#22601f"/></radialGradient>'
 +'<radialGradient id="apple" cx=".25" cy=".18" r=".85"><stop stop-color="#f7a242"/><stop offset=".24" stop-color="#df4720"/><stop offset=".72" stop-color="#ae2413"/><stop offset="1" stop-color="#632514"/></radialGradient>'
 +'<linearGradient id="bark" x1="0" y1="0" x2="1" y2=".3"><stop stop-color="#4b301f"/><stop offset=".35" stop-color="#93632b"/><stop offset=".7" stop-color="#b0803f"/><stop offset="1" stop-color="#422c1c"/></linearGradient>'
 +'<linearGradient id="redPlanks" x1="0" y1="0" x2="1" y2=".4"><stop stop-color="#8b2318"/><stop offset=".3" stop-color="#de4630"/><stop offset=".7" stop-color="#b63222"/><stop offset="1" stop-color="#86271e"/></linearGradient>'
 +'<linearGradient id="roof" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#a37651"/><stop offset=".42" stop-color="#523626"/><stop offset=".8" stop-color="#362820"/><stop offset="1" stop-color="#b08352"/></linearGradient>'
 +'<linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f7d88d"/><stop offset=".38" stop-color="#c9954e"/><stop offset="1" stop-color="#815027"/></linearGradient>'
 +'<linearGradient id="blade" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#86562d"/><stop offset=".3" stop-color="#e2b26a"/><stop offset=".78" stop-color="#f4db98"/><stop offset="1" stop-color="#97682e"/></linearGradient>'
 +'<linearGradient id="stone" x1="0" y1="0" x2="1" y2=".45"><stop stop-color="#706d60"/><stop offset=".37" stop-color="#dfd2ad"/><stop offset=".7" stop-color="#aea38b"/><stop offset="1" stop-color="#80776c"/></linearGradient>'
 +'<linearGradient id="rock" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e7dfc6"/><stop offset=".4" stop-color="#97968b"/><stop offset="1" stop-color="#5a645e"/></linearGradient>'
 +'<linearGradient id="door" x1="0" y1="0" x2="1" y2=".4"><stop stop-color="#130f0c"/><stop offset=".6" stop-color="#3a2413"/><stop offset="1" stop-color="#72401b"/></linearGradient>'
 +'<linearGradient id="sand" x1="0" y1="0" x2=".6" y2="1"><stop stop-color="#ead0a4"/><stop offset=".6" stop-color="#cbaa79"/><stop offset="1" stop-color="#dfbb88"/></linearGradient>'
 +'<linearGradient id="hay" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="#ffdc72"/><stop offset=".55" stop-color="#da9b2c"/><stop offset="1" stop-color="#a76d1e"/></linearGradient>'
 +'<radialGradient id="egg" cx=".25" cy=".19" r=".9"><stop stop-color="#fffef2"/><stop offset=".7" stop-color="#f3e9cc"/><stop offset="1" stop-color="#bdab84"/></radialGradient>'
 +'<radialGradient id="water" cx=".46" cy=".4" r=".85"><stop stop-color="#4bd1e2"/><stop offset=".65" stop-color="#177894"/><stop offset="1" stop-color="#0c435b"/></radialGradient>'
 +'<radialGradient id="feathersWhite" cx=".29" cy=".2" r=".9"><stop stop-color="#fffefa"/><stop offset=".6" stop-color="#f2eee2"/><stop offset="1" stop-color="#bdbcb3"/></radialGradient>'
 +'<radialGradient id="feathersGold" cx=".28" cy=".2" r=".9"><stop stop-color="#fff1b1"/><stop offset=".6" stop-color="#e6b365"/><stop offset="1" stop-color="#a66b33"/></radialGradient>'
 +'<linearGradient id="beak"><stop stop-color="#ffe787"/><stop offset="1" stop-color="#d48a22"/></linearGradient>'
 +'<radialGradient id="corn"><stop stop-color="#f8e277"/><stop offset="1" stop-color="#d69b28"/></radialGradient>'
 +'<radialGradient id="gold"><stop stop-color="#fff2a2"/><stop offset="1" stop-color="#b87827"/></radialGradient>'
 +'<filter id="softShadow" x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur in="SourceAlpha" stdDeviation="2" result="b"/><feOffset dy="3" dx="2" in="b" result="s"/><feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
 +'</defs>';
 var out='<svg xmlns="http://www.w3.org/2000/svg" class="henova-procedural-farm" role="img" aria-label="Animated farm made entirely from SVG code" viewBox="0 0 650 1155" preserveAspectRatio="xMidYMid slice">'+defs;
 out+='<rect width="650" height="1155" fill="url(#ground)"/>';
 out+=path('M-40 82 Q152 -13 315 62 Q486 -19 704 64 L704 285 Q310 221 -20 286 Z','#8ac13f','opacity=".56"');
 out+=path('M-40 151 Q140 63 301 145 Q479 55 701 155 L700 366 Q335 255 -40 370 Z','#579a2f','opacity=".4"');
 out+=grass();
 // Orchard in depth, behind structures.
 out+=tree(40,139,.75,1)+tree(188,236,.92,2)+tree(365,166,.77,3)+tree(553,274,.95,4)+tree(42,342,1,5)+tree(343,394,1.07,6)+tree(665,344,.94,7);
 out+=blossomFields();
 out+=fence();
 out+=pathwalk();
 out+=coop();
 out+=windmill();
 out+=nest()+feeder();
 out+=hay(25,957,1.25)+hay(-19,907,.77);
 out+=bush(330,794,1.05)+bush(80,1092,.75)+bush(596,1045,.72)+bush(19,1044,.9);
 out+=pond();
 out+=chicken(393,650,1.17,'white',0,4.8);
 out+=chicken(464,722,.63,'gold',1.8,5.3);
 out+=chicken(115,1000,.91,'white',2.4,6);
 out+=chicken(484,1023,.72,'gold',3.1,4.5);
 out+='</svg>';
 return out;
}
function style(){
 return '#henova-admin-scene-preview #henova-code-farm{position:absolute;inset:0;width:100%;height:100%;overflow:hidden;background:linear-gradient(#86ba42,#478723)}'
 +'#henova-code-farm svg{display:block;width:100%;height:100%}'
 +'#henova-admin-scene-preview .hv-rotor{animation:hvRotor 5.3s linear infinite;transform-origin:0px 0px;transform-box:view-box}'
 +'#henova-admin-scene-preview .hv-chicken-walk{animation:hvFarmWalk 6s ease-in-out infinite alternate;transform-origin:0 10px}'
 +'#henova-admin-scene-preview .hv-chicken-head{animation:hvHenPeck 3.1s ease-in-out infinite;transform-origin:13px -20px}'
 +'#henova-admin-scene-preview .hv-chicken-tail{animation:hvHenTail 2.2s ease-in-out infinite;transform-origin:-19px -15px}'
 +'@keyframes hvRotor{to{transform:rotate(360deg)}}'
 +'@keyframes hvFarmWalk{0%{transform:translate(-8px,0) scaleX(1)}40%{transform:translate(15px,-2px) scaleX(1)}55%{transform:translate(13px,0) scaleX(-1)}100%{transform:translate(-7px,2px) scaleX(-1)}}'
 +'@keyframes hvHenPeck{0%,52%,100%{transform:rotate(0)}60%,72%{transform:rotate(21deg)}}'
 +'@keyframes hvHenTail{0%,100%{transform:rotate(0)}50%{transform:rotate(7deg)}}'
 +'@media(prefers-reduced-motion:reduce){#henova-admin-scene-preview .hv-rotor,#henova-admin-scene-preview .hv-chicken-walk,#henova-admin-scene-preview .hv-chicken-head,#henova-admin-scene-preview .hv-chicken-tail{animation:none}}';
}
window.henovaBuildCodeFarm=function(){
 var root=document.getElementById('henova-code-farm');
 if(!root)return false;
 if(!document.getElementById('henova-code-farm-style')){
  var node=document.createElement('style');node.id='henova-code-farm-style';node.textContent=style();document.head.appendChild(node);
 }
 if(!root.dataset.built){root.innerHTML=scene();root.dataset.built='1';}
 return true;
};
})();