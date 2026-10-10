import type {Key} from 'ink';

export function keyName(input:string,key:Key):string {
  if (key.ctrl) return `Ctrl+${input.toLowerCase()}`;
  if(key.return)return 'Enter'; if(key.escape)return 'Esc'; if(key.tab)return 'Tab';
  if(key.upArrow)return 'Up';if(key.downArrow)return 'Down';if(key.leftArrow)return 'Left';if(key.rightArrow)return 'Right';
  if(key.home)return 'Home';if(key.end)return 'End';if(key.pageUp)return 'PageUp';if(key.pageDown)return 'PageDown';
  if(key.backspace)return 'Backspace';if(key.delete)return 'Delete';
  return input===' '?'Space':input;
}

/** Ink 7's public Key omits function keys. Observe bytes without consuming them. */
export class F1Observer {
  private sequence=''; private paste=false;
  push(chunk:string):number {
    let count=0;
    for(const char of chunk){
      if(char==='\x1b'){this.sequence=char;continue;}
      if(!this.sequence)continue;
      this.sequence+=char;
      if(this.sequence==='\x1b['||this.sequence==='\x1bO')continue;
      if(this.sequence==='\x1b[200~'){this.paste=true;this.sequence='';continue;}
      if(this.sequence==='\x1b[201~'){this.paste=false;this.sequence='';continue;}
      if(!this.paste&&['\x1bOP','\x1b[P','\x1b[11~','\x1b[[A'].includes(this.sequence))count++;
      if(/[A-Za-z~]$/u.test(this.sequence)||this.sequence.length>16)this.sequence='';
    }
    return count;
  }
}
