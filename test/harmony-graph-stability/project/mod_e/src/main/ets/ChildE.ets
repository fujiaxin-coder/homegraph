@Component
struct ChildE {
  @Prop label: string = '';

  build() {
    Row() {
      Text(this.label)
        .onClick(() => {
          console.info('child-E');
        })
    }
  }
}

export { ChildE };
