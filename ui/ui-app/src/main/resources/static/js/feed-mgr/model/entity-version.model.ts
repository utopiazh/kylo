export interface EntityVersion {

    id:string;
    name:string;
    createdDate:number;
    entityId:string;
    entity?:any;
    deployedVersion?:EntityVersion

}