// Простой pub-sub стор для состояния интерфейса.
// Данные звонков/контактов — не здесь, а в адаптерах (js/adapters/*),
// это состояние — только про то, что сейчас видно на экране.

function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get() { return state; },
    set(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      listeners.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const uiStore = createStore({
  dialInput: '',
  keyboardVisible: true,
  searchOpen: false,
  searchQuery: '',
  contextMenuFor: null, // id группированной строки истории
  screen: 'home', // 'home' | 'contact-history'
  contactHistoryFor: null, // number
});
