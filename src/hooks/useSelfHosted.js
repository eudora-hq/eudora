export function useSelfHosted() {
  return import.meta.env.VITE_SELF_HOSTED === 'true'
}
