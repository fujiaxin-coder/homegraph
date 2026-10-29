@Component
struct ChildC {
  @Prop label: string = '';

  build() {
    Row() {
      Text(this.label)
        .onClick(() => {
          console.info('child-C');
        })
    }
  }
}

export { ChildC };
