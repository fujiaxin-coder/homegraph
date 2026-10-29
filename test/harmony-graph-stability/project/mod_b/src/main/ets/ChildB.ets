@Component
struct ChildB {
  @Prop label: string = '';

  build() {
    Row() {
      Text(this.label)
        .onClick(() => {
          console.info('child-B');
        })
    }
  }
}

export { ChildB };
