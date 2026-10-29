@Component
struct ChildD {
  @Prop label: string = '';

  build() {
    Row() {
      Text(this.label)
        .onClick(() => {
          console.info('child-D');
        })
    }
  }
}

export { ChildD };
