export interface IFaceC {
  tag(): string;
}

export class BaseC implements IFaceC {
  tag(): string {
    return 'C';
  }
}
