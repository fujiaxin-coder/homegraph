@Component
struct ChildA {
  @Prop label: string = '';

  build() {
    Row() {
      Text(this.label)
        .onClick(() => {
          console.info('child-A');
        })
    }
  }
}

export { ChildA };
