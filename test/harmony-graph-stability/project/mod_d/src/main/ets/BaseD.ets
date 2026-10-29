export interface IFaceD {
  tag(): string;
}

export class BaseD implements IFaceD {
  tag(): string {
    return 'D';
  }
}
