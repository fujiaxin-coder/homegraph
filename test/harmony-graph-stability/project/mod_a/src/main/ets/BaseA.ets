export interface IFaceA {
  tag(): string;
}

export class BaseA implements IFaceA {
  tag(): string {
    return 'A';
  }
}
