export function useWaiter() {
  function waitToBeTruthy(getVariable: () => boolean, interval = 100) {
    return new Promise((resolve) => {
      const checkVariable = () => {
        if (getVariable()) {
          resolve(true)
        } else {
          setTimeout(checkVariable, interval)
        }
      }
      checkVariable()
   })
  }

  return { waitToBeTruthy}
}