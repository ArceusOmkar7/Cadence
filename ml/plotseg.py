import sys, numpy as np, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from glovedata import *; from segment import *
sess=sys.argv[1]; ids=sys.argv[2].split(','); out=sys.argv[3]
meta,sets,mot,der,ana,ev=load_session(sess); lab='set_id' in der
fig,ax=plt.subplots(len(ids),1,figsize=(14,2.5*len(ids))); ax=np.atleast_1d(ax)
for a,i in zip(ax,ids):
    r=sets[sets.set_id.str.endswith('-'+i)].iloc[0]; d=set_frame(sess,r,der,lab)
    g,x,hole=grid(d,GYR+ACC); G=np.c_[[x[c] for c in GYR]].T; A=np.c_[[x[c] for c in ACC]].T
    es,pk=peaks_for(g,G,A); t=(g-g[0])/1e6
    a.plot(t,es,lw=.8); a.axhline(.35,c='r',lw=.5)
    for j in pk: a.axvline(t[j],c='g',alpha=.6)
    a.set_title(f'{i} {r.label} peaks={len(pk)}',fontsize=9); a.set_ylim(0,min(es.max()*1.1,5))
fig.tight_layout(); fig.savefig(out,dpi=75)
