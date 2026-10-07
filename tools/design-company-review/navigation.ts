export const useRouter=()=>({push:(url:string)=>(window as any).designAudit.routes.push(url),replace:()=>{},refresh:()=>{},prefetch:()=>{}});
export const usePathname=()=>'/matches';
export const useSearchParams=()=>new URLSearchParams(window.location.search);
export const useParams=()=>({});
