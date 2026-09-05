// trial fixture: 崩溃插件 —— apply 抛错
export default {
  name: 'trial-crash',
  apply() {
    throw new Error('simulated crash inside plugin apply')
  },
}
