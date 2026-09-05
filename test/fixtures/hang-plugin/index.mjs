// trial fixture: 卡死插件 —— apply 永不结束（测超时）
export default {
  name: 'trial-hang',
  apply() {
    return new Promise(() => { /* never settles */ })
  },
}
