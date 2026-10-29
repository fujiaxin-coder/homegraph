export interface IFaceB {
  tag(): string;
}

export class BaseB implements IFaceB {
  tag(): string {
    return 'B';
  }
}
